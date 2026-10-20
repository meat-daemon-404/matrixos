const re = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
for (const s of ["ab", "abc", "a1", "curvelab", "03-grant-audit", "a".repeat(32), "a".repeat(33)]) {
  console.log(JSON.stringify(s), "len=" + s.length, re.test(s));
}
