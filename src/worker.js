import {
  receive,
  cleanup,
  mailDomain,
  normalizeAddress,
  RETENTION_MS,
  LIMITS,
  extractLinks,
} from "./mail.js";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const messagePath = new RegExp(
  `^/api/messages/(${uuid})(?:/images/(${uuid}))?$`,
);
const columns =
  'id,address,from_address AS "from",from_name AS fromName,subject,code,preview,status,received_at AS receivedAt,expires_at AS expiresAt';
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function json(data, status = 200, extra = {}) {
  return Response.json(data, { status, headers: { ...headers, ...extra } });
}
function invalid(message) {
  throw new HttpError(400, "INVALID_QUERY", message);
}
function methodNotAllowed(allow) {
  return json(
    {
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "此接口不支持该请求方法。",
      },
    },
    405,
    { Allow: allow },
  );
}

function accessKey(env) {
  if (
    typeof env.ACCESS_KEY !== "string" ||
    !/^[\x21-\x7e]+$/.test(env.ACCESS_KEY)
  )
    throw new HttpError(
      503,
      "NOT_CONFIGURED",
      "请配置访问密钥，使用不含空格的英文字母、数字或符号。",
    );
  return env.ACCESS_KEY;
}

async function authorized(request, env) {
  const key = accessKey(env);
  const supplied =
    /^Bearer +([^\s]+)$/i.exec(
      request.headers.get("Authorization") || "",
    )?.[1] || "";
  const hash = (value) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [expected, actual] = await Promise.all([hash(key), hash(supplied)]);
  return crypto.subtle.timingSafeEqual(expected, actual);
}

async function listMessages(url, env, now) {
  const params = url.searchParams,
    clauses = ["expires_at > ?"],
    values = [now];
  const address = params.get("address");
  if (address !== null) {
    const normalized = normalizeAddress(address, mailDomain(env));
    if (!normalized) invalid("请使用当前域名下的完整邮箱地址。");
    clauses.push("address = ?");
    values.push(normalized);
  }
  if (params.has("since")) {
    const since = Number(params.get("since"));
    if (!params.get("since") || !Number.isSafeInteger(since) || since < 0)
      invalid("since 必须是毫秒时间戳。");
    clauses.push("received_at >= ?");
    values.push(since);
  }
  const query = (params.get("q") || "").trim();
  if (query.length > 200) invalid("搜索词请控制在 200 字以内。");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 6) invalid("每次最多搜索 6 个关键词。");
  for (const word of words) {
    clauses.push(
      "instr(lower(address || ' ' || from_address || ' ' || from_name || ' ' || subject || ' ' || code || ' ' || text), ?) > 0",
    );
    values.push(word);
  }
  const cursor = params.get("cursor");
  if (cursor) {
    const match = new RegExp(`^(\\d{1,16}):(${uuid})$`).exec(cursor);
    if (!match || !Number.isSafeInteger(Number(match[1])))
      invalid("分页位置无效，请重新查询。");
    clauses.push("(received_at < ? OR (received_at = ? AND id < ?))");
    values.push(Number(match[1]), Number(match[1]), match[2]);
  }
  const limit = params.has("limit") ? Number(params.get("limit")) : 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    invalid("limit 必须在 1 到 100 之间。");
  const result = await env.DB.prepare(
    `SELECT ${columns} FROM messages WHERE ${clauses.join(" AND ")} ORDER BY received_at DESC,id DESC LIMIT ?`,
  )
    .bind(...values, limit + 1)
    .all();
  const messages = result.results.slice(0, limit),
    last = messages.at(-1);
  return json({
    messages,
    nextCursor:
      result.results.length > limit ? `${last.receivedAt}:${last.id}` : null,
    serverTime: now,
  });
}

async function api(request, env) {
  const url = new URL(request.url),
    now = Date.now();
  if (!(await authorized(request, env))) {
    const { success } = await env.AUTH_LIMITER.limit({
      key: request.headers.get("CF-Connecting-IP") || "local",
    });
    if (!success)
      return json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "密钥尝试过于频繁，请稍后重试。",
          },
        },
        429,
        { "Retry-After": "60" },
      );
    return json(
      { error: { code: "UNAUTHORIZED", message: "密钥不正确，请重新输入。" } },
      401,
      { "WWW-Authenticate": "Bearer" },
    );
  }
  if (url.pathname === "/api/status") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    await env.DB.prepare("SELECT id FROM messages LIMIT 1").all();
    return json({
      domain: mailDomain(env),
      serverTime: now,
      retentionMs: RETENTION_MS,
      limits: LIMITS,
    });
  }
  if (url.pathname === "/api/messages")
    return request.method === "GET"
      ? listMessages(url, env, now)
      : methodNotAllowed("GET");
  const path = messagePath.exec(url.pathname);
  if (path) {
    const [, id, imageId] = path;
    if (imageId && request.method === "GET") {
      const image = await env.DB.prepare(
        "SELECT images.content_type,images.data FROM images JOIN messages ON messages.id = images.message_id WHERE images.id = ? AND messages.id = ? AND messages.expires_at > ?",
      )
        .bind(imageId, id, now)
        .first();
      if (!image)
        throw new HttpError(404, "NOT_FOUND", "图片已删除、到期或不存在。");
      return new Response(new Uint8Array(image.data), {
        headers: {
          ...headers,
          "Content-Type": image.content_type,
          "Content-Disposition": "inline",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }
    if (!imageId && request.method === "GET") {
      const message = await env.DB.prepare(
        `SELECT ${columns},text,html,omitted_images AS omittedImages FROM messages WHERE id = ? AND expires_at > ?`,
      )
        .bind(id, now)
        .first();
      if (!message)
        throw new HttpError(404, "NOT_FOUND", "邮件已删除、到期或不存在。");
      const images = await env.DB.prepare(
        "SELECT id,content_id AS contentId,content_type AS contentType,length(data) AS size FROM images WHERE message_id = ?",
      )
        .bind(id)
        .all();
      message.images = images.results.map((image) => ({
        ...image,
        url: `/api/messages/${id}/images/${image.id}`,
      }));
      message.links = await extractLinks(message.html, message.text);
      return json(message);
    }
    if (!imageId && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
      return new Response(null, { status: 204, headers });
    }
    return methodNotAllowed(imageId ? "GET" : "GET, DELETE");
  }
  throw new HttpError(404, "NOT_FOUND", "接口不存在。");
}

export default {
  async fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith("/api/"))
      return env.ASSETS.fetch(request);
    try {
      return await api(request, env);
    } catch (error) {
      if (error instanceof HttpError)
        return json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      console.error(
        "api_unavailable",
        error.message === "MAIL_DOMAIN_NOT_CONFIGURED"
          ? "domain_not_configured"
          : "storage_or_runtime_failure",
      );
      return json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "邮箱服务或数据库暂时不可用，请稍后重试。",
          },
        },
        503,
      );
    }
  },
  async email(message, env) {
    try {
      await receive(message, env);
    } catch (error) {
      console.error(
        "email_not_saved",
        String(error.message).includes("MAILBOX_FULL")
          ? "mailbox_full"
          : "storage_or_runtime_failure",
      );
      throw error;
    }
  },
  async scheduled(_event, env) {
    await cleanup(env.DB);
  },
};
