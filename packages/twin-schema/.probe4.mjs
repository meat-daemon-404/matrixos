const re = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const stations = ["study","spark","pat_hot","xingmen","workshop","cloud_balance","pre_job"];
for (const s of stations) console.log(s.padEnd(16), "matches microsite key:", re.test(s));
