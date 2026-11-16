import PostalMime, { decodeWords } from "postal-mime";
import { decodeHTML, decodeHTMLAttribute } from "entities";

export const RETENTION_MS = 24 * 60 * 60 * 1000;
export const LIMITS = Object.freeze({
  rawBytes: 2 * 1024 * 1024,
  bodyBytes: 512 * 1024,
  imageBytes: 256 * 1024,
  imagesBytes: 512 * 1024,
  images: 8,
});
const encoder = new TextEncoder();
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function mailDomain(env) {
  const domain = String(env.MAIL_DOMAIN || "")
    .trim()
    .toLowerCase();
  if (
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(
      domain,
    )
  )
    throw Error("MAIL_DOMAIN_NOT_CONFIGURED");
  return domain;
}

export function normalizeAddress(value, domain) {
  const address = String(value || "")
    .trim()
    .toLowerCase();
  const at = address.lastIndexOf("@");
  if (
    at < 1 ||
    at > 64 ||
    address.slice(at + 1) !== domain ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(address.slice(0, at))
  )
    return "";
  if (
    address.startsWith(".") ||
    address[at - 1] === "." ||
    address.slice(0, at).includes("..")
  )
    return "";
  return address;
}

export function extractCode(subject, text) {
  const input = `${subject}\n${text}`
    .slice(0, 12000)
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, (url) => " ".repeat(url.length))
    .replace(/\b(\d{3})[ \u00a0-](\d{3})\b/g, "$1$2");
  const labels = input.matchAll(
    /验证码|校验码|确认码|动态码|验证代码|一次性密码|(?:your|verification|security|confirmation|authentication|login|sign[ -]?in|one[ -]?time)[ -]?(?:code|password)|\b(?:OTP|passcode)\b/gi,
  );
  const candidates = new Set();
  // 只接受紧邻验证提示的码，避免把链接编号、年份或客服编号当成验证码。
  for (const label of labels) {
    const after = input
      .slice(label.index + label[0].length, label.index + label[0].length + 120)
      .match(
        /^[\s:：=。.“"'（(【-]*(?:(?:is|为|是|to (?:confirm|verify) your (?:email(?: address)?|account)|(?:确认|验证)(?:您|你)的(?:邮箱|电子邮件)(?:地址)?)\s*[\s:：=。.“"'（(【-]*)?([a-z0-9]{4,8})\b/i,
      );
    const before = input
      .slice(Math.max(0, label.index - 120), label.index)
      .match(
        /\b([a-z0-9]{4,8})(?:\s+is\s+(?:your|the)\s+(?:[a-z]+\s+){0,3})?[\s”"'）)】-]*$/i,
      );
    for (const match of [after, before])
      if (match && /\d/.test(match[1])) candidates.add(match[1]);
  }
  return candidates.size === 1 ? [...candidates][0] : "";
}

async function readHtml(html) {
  let text = "",
    hidden = false;
  const images = new Set();
  await new HTMLRewriter()
    .on("script,style", {
      element(element) {
        hidden = true;
        element.onEndTag(() => {
          hidden = false;
        });
      },
    })
    .on("br,hr,p,div,tr,td,th,li,h1,h2,h3,section,blockquote", {
      element(element) {
        text += " ";
        if (!["br", "hr"].includes(element.tagName))
          element.onEndTag(() => {
            text += " ";
          });
      },
    })
    .on("img[src]", {
      element(element) {
        const src = decodeHTMLAttribute(element.getAttribute("src") || "");
        if (/^cid:/i.test(src)) {
          const id = src.slice(4).replace(/^<|>$/g, "");
          try {
            images.add(decodeURIComponent(id));
          } catch {
            images.add(id);
          }
        }
      },
    })
    .onDocument({
      text(chunk) {
        if (!hidden) text += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return { text: decodeHTML(text).replace(/\s+/g, " ").trim(), images };
}

async function readRaw(message) {
  const reader = message.raw.getReader(),
    chunks = [];
  let size = 0;
  try {
    if (message.rawSize > LIMITS.rawBytes) {
      await reader.cancel();
      return null;
    }
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.rawBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function cleanup(db, now = Date.now()) {
  return db
    .prepare("DELETE FROM messages WHERE expires_at <= ?")
    .bind(now)
    .run();
}

export async function receive(message, env) {
  const address = normalizeAddress(message.to, mailDomain(env));
  if (!address) {
    message.setReject("Recipient domain is not served here");
    return;
  }
  const receivedAt = Date.now(),
    id = crypto.randomUUID(),
    raw = await readRaw(message);
  let parsed;
  if (raw) {
    try {
      parsed = await PostalMime.parse(raw, {
        maxNestingDepth: 20,
        maxPartCount: 100,
        maxHeadersSize: 65536,
        maxRfc822NestingDepth: 0,
      });
    } catch (error) {
      if (
        ![
          "EMAXNESTINGDEPTH",
          "EMAXPARTCOUNT",
          "EMAXHEADERSIZE",
          "EMAXFORWARDEDADDRESSES",
        ].includes(error.code)
      )
        throw error;
      message.setReject("Message MIME format exceeds supported limits");
      return;
    }
  }
  const subject = String(
    parsed?.subject ||
      decodeWords((message.headers.get("subject") || "").slice(0, 4096)),
  ).slice(0, 1000);
  const from = String(parsed?.from?.address || message.from || "").slice(
      0,
      320,
    ),
    name = String(parsed?.from?.name || "").slice(0, 200);
  let text = String(parsed?.text || ""),
    html = String(parsed?.html || ""),
    status = "received";
  const content =
    html &&
    encoder.encode(text).byteLength + encoder.encode(html).byteLength <=
      LIMITS.bodyBytes
      ? await readHtml(html)
      : null;
  if (!text && content) text = content.text;
  if (
    !raw ||
    encoder.encode(text).byteLength + encoder.encode(html).byteLength >
      LIMITS.bodyBytes
  ) {
    text = "";
    html = "";
    status = "too_large";
  }
  const codeText =
    html && content.text !== text
      ? `${text.slice(0, 5500)}\n${content.text.slice(0, 5500)}`
      : text;
  const code = extractCode(subject, codeText);
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 240);
  const images = [];
  let imageBytes = 0,
    omittedImages = 0;
  for (const attachment of parsed?.attachments || []) {
    if (!attachment.contentId || !html) continue;
    const contentId = attachment.contentId.replace(/^<|>$/g, "");
    if (!content.images.has(contentId)) continue;
    const data =
      attachment.content instanceof ArrayBuffer
        ? new Uint8Array(attachment.content)
        : attachment.content;
    if (
      !imageTypes.has(attachment.mimeType) ||
      !contentId ||
      contentId.length > 200 ||
      /[\s<>]/.test(contentId) ||
      images.some((image) => image.contentId === contentId) ||
      data.byteLength > LIMITS.imageBytes ||
      imageBytes + data.byteLength > LIMITS.imagesBytes ||
      images.length >= LIMITS.images
    ) {
      omittedImages++;
      continue;
    }
    images.push({
      id: crypto.randomUUID(),
      contentId,
      type: attachment.mimeType,
      data,
    });
    imageBytes += data.byteLength;
  }
  const storageBytes =
    encoder.encode(
      JSON.stringify({
        address,
        from,
        name,
        subject,
        code,
        text,
        html,
        preview,
      }),
    ).byteLength +
    imageBytes +
    1024;
  const insert = () =>
    env.DB.batch([
      env.DB.prepare(
        "INSERT INTO messages (id,address,from_address,from_name,subject,code,text,html,preview,status,received_at,expires_at,storage_bytes,omitted_images) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        address,
        from,
        name,
        subject,
        code,
        text,
        html,
        preview,
        status,
        receivedAt,
        receivedAt + RETENTION_MS,
        storageBytes,
        omittedImages,
      ),
      ...images.map((image) =>
        env.DB.prepare(
          "INSERT INTO images (id,message_id,content_id,content_type,data) VALUES (?,?,?,?,?)",
        ).bind(image.id, id, image.contentId, image.type, image.data),
      ),
    ]);
  try {
    await insert();
  } catch (error) {
    if (!String(error.message).includes("MAILBOX_FULL")) throw error;
    await cleanup(env.DB);
    await insert();
  }
}
