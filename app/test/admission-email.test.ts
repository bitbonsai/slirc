import { expect, test } from "bun:test";
import { admissionEmail } from "../src/admissions-email.ts";

test("admission links share one capability in both parts and leak no local paths", () => {
  const token = "EXAMPLE-ONLY-NOT-A-REAL-TOKEN";
  const email = admissionEmail({ token, origin: "https://slirc.org", appOrigin: "https://app.slirc.org" });
  const helpUrl = `https://app.slirc.org/admission#token=${token}&destination=help`;
  const founderUrl = `https://app.slirc.org/admission#token=${token}&destination=founder`;
  expect(email.html).toContain(`href="${helpUrl.replaceAll("&", "&amp;")}"`);
  expect(email.html).toContain(`href="${founderUrl.replaceAll("&", "&amp;")}"`);
  expect(email.html.match(/<a\b/g)).toHaveLength(2);
  expect(email.text).toContain(founderUrl);
  expect(email.text).toContain(helpUrl);
  for (const body of [email.html, email.text]) {
    expect(body).not.toContain("file:///home");
    expect(body.toLowerCase()).not.toContain("prelaunch");
    expect(body).not.toContain("Mauricio");
    expect(body).not.toContain("bitbonsai");
  }
  expect(email.text).not.toContain("<p>");

  const signed = admissionEmail({ token, origin: "https://slirc.org", appOrigin: "https://app.slirc.org", owner: { nick: "ada", name: "Ada Lovelace" } });
  expect(signed.html).toContain("@ada");
  expect(signed.html).toContain("Ada Lovelace");
  expect(signed.text).toContain("@ada");
  expect(signed.text).toContain("Ada Lovelace");
});
