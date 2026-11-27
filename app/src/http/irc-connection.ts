

// Advertised IRC connection for generated client configs (no secrets). TLS is always on; the
// self-signed exception is offered only for a server-authorized loopback development endpoint, so
// a page protocol or client hostname can never weaken production trust.
export function ircConnectionMeta(): { host: string; port: number; tls: true; allowSelfSigned: boolean; local: boolean } {
  const configuredHost = (process.env.SLIRC_IRC_HOST || "").trim();
  const configuredPort = Number(process.env.SLIRC_IRC_PORT);
  const devProfile = process.env.SLIRC_DEV_PROFILE === "slirc2" || process.env.SLIRC_IRC_LOCAL_DEV === "true";
  const host = configuredHost || (devProfile ? "127.0.0.1" : "");
  const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : (devProfile ? 6797 : 6697);
  const loopback = /^(127\.0\.0\.1|::1|localhost)$/i.test(host);
  return { host, port, tls: true, allowSelfSigned: devProfile && loopback, local: loopback };
}
