/* Seeds (or removes) the doctor-name map in the settings table.
   Reads the project URL + anon key straight from app.js so nothing is retyped.
   node seed-doctors.js          -> upsert mapping
   node seed-doctors.js --delete -> remove mapping (full rollback) */
const fs = require("fs");

const src = fs.readFileSync("app.js", "utf8");
const URL_BASE = src.match(/SUPABASE_URL = "([^"]+)"/)[1];
const KEY = src.match(/ANON_KEY = "([^"]+)"/)[1];

const DOCTORS = {
  A: "Dr Gamage",
  B: "Dr Badrani",
  C: "Dr Dammika",
  D: "Dr Thusitha",
  E: "Dr Faseeha",
  F: "Dr Priyangani",
  H: "Dr Rashida",
  J: "Dr Ruwan",
  N: "Dr Wasantha",
  P: "Dr Senaka",
  Q: "Dr Chintha",
  R: "Dr Ishara",
  S: "Dr Praneetha",
  T: "Dr Shiyana",
  U: "Dr Upeka",
  V: "Dr Prasanga"
};

const headers = {
  apikey: KEY,
  Authorization: "Bearer " + KEY,
  "Content-Type": "application/json"
};

(async () => {
  const remove = process.argv.includes("--delete");

  const check = await fetch(URL_BASE + "/rest/v1/settings?select=key", { headers });
  if (!check.ok) {
    console.log("READ FAILED", check.status, (await check.text()).slice(0, 200));
    process.exit(1);
  }

  if (remove) {
    const res = await fetch(URL_BASE + "/rest/v1/settings?key=eq.doctors", {
      method: "DELETE",
      headers: { ...headers, Prefer: "return=representation" }
    });
    console.log("DELETE", res.status, (await res.text()).slice(0, 200));
    return;
  }

  const res = await fetch(URL_BASE + "/rest/v1/settings?on_conflict=key", {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ key: "doctors", value: JSON.stringify(DOCTORS) })
  });
  console.log("UPSERT", res.status, (await res.text()).slice(0, 400));
})();
