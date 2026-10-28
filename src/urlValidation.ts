/** Validates custom API endpoints before they are saved. */
export function validateOutboundApiUrl(value: string, label = "API URL") {
  const normalized = value.trim();
  if (!normalized) return `请输入 ${label}`;
  try {
    const parsed = new URL(normalized);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      return `${label}必须是有效的 HTTP(S) 地址`;
    }
    if (parsed.username || parsed.password) {
      return `${label}不能包含用户名或密码，请在 Key 字段单独填写凭据`;
    }
    return "";
  } catch {
    return `${label}格式无效`;
  }
}

/** Validates the Codex launch proxy before it is saved. The same rules apply
 * in the backend: credentials are injected by the local auth relay (Chromium's
 * --proxy-server cannot carry them) and SOCKS rules require an explicit port. */
export function validateCodexLaunchProxy(value: string, label = "Codex 启动代理") {
  const normalized = value.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (
      !["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) ||
      !parsed.hostname
    ) {
      return `${label}必须是 http、https、socks5 或 socks5h 地址`;
    }
    if (isUnusableProxyHost(parsed.hostname)) {
      return `${label}不能指向未指定地址或链路本地地址`;
    }
    // 非特殊协议（socks5/socks5h）的 pathname 是空串而非 "/"。
    // 空的 ? 或 # 在 URL 对象里 search/hash 为空串，后端按存在与否拒绝，所以看原文。
    if (!["", "/"].includes(parsed.pathname) || /[?#]/.test(normalized)) {
      return `${label}只能包含协议、地址、端口和认证信息`;
    }
    const isSocks = parsed.protocol === "socks5:" || parsed.protocol === "socks5h:";
    if (isSocks && !parsed.port) {
      return `${label}的 SOCKS 地址必须带端口`;
    }
    // RFC 1929 的用户名和密码各限 255 字节；http/https 代理没有这个限制，
    // 后端也只对 SOCKS 地址做同样约束。
    if (
      isSocks &&
      (credentialByteLength(parsed.username) > 255 || credentialByteLength(parsed.password) > 255)
    ) {
      return `${label}的 SOCKS 用户名或密码不能超过 255 字节`;
    }
    return "";
  } catch {
    return `${label}格式无效`;
  }
}

/** True when a valid launch proxy address carries a username or password. */
export function codexLaunchProxyHasCredentials(value: string) {
  if (validateCodexLaunchProxy(value)) return false;
  const normalized = value.trim();
  if (!normalized) return false;
  const parsed = new URL(normalized);
  return Boolean(parsed.username || parsed.password);
}

// 与后端一致：按百分号解码后的原始字节计数，解码结果不要求是合法 UTF-8。
function credentialByteLength(value: string) {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    if (value[index] === "%" && /^[0-9a-fA-F]{2}$/.test(value.slice(index + 1, index + 3))) {
      bytes += 1;
      index += 3;
      continue;
    }
    const codePoint = value.codePointAt(index) as number;
    const char = String.fromCodePoint(codePoint);
    bytes += encoder.encode(char).length;
    index += char.length;
  }
  return bytes;
}

// 与后端一致：未指定地址、链路本地地址和广播地址不能作为代理主机。
function isUnusableProxyHost(hostname: string) {
  if (hostname.startsWith("[")) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    return ipv6 === "::" || /^fe[89ab][0-9a-f]:/.test(ipv6);
  }
  const octets = hostname.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part))) return false;
  const [a, b, c, d] = octets.map(Number);
  if ([a, b, c, d].some((part) => part > 255)) return false;
  return (a === 0 && b === 0 && c === 0 && d === 0) || (a === 169 && b === 254) ||
    (a === 255 && b === 255 && c === 255 && d === 255);
}
