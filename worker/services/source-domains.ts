// A compact approximation of the common multi-label public suffixes likely to
// appear in fantasy-football sources. This is deliberately conservative: the
// default remains the final two labels, while these suffixes retain one more.
const commonMultiLabelPublicSuffixes = new Set([
  "ac.uk", "co.uk", "gov.uk", "me.uk", "net.uk", "org.uk",
  "asn.au", "com.au", "edu.au", "gov.au", "net.au", "org.au",
  "ac.nz", "co.nz", "govt.nz", "net.nz", "org.nz",
  "co.in", "firm.in", "gen.in", "ind.in", "net.in", "org.in",
  "co.jp", "ne.jp", "or.jp",
  "co.kr", "ne.kr", "or.kr",
  "com.br", "net.br", "org.br",
  "com.cn", "net.cn", "org.cn",
  "com.mx", "com.sg", "com.tw", "co.za", "com.ar",
]);

export function canonicalSourceDomain(url: string) {
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2 || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(":")) return hostname;
  const finalTwo = labels.slice(-2).join(".");
  return commonMultiLabelPublicSuffixes.has(finalTwo)
    ? labels.slice(-3).join(".")
    : finalTwo;
}
