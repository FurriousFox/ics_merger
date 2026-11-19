import ICAL from "ical.js";

import http from "node:http";
import process, { env } from "node:process";
import fs from "node:fs";
import path from "node:path";


process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

type Config = {
  port: number;
  host: string;

  urls: Record<string, string[]>;
};

// Read config
const CONFIG = path.join(import.meta.dirname!, "./config.json");
const ENV = path.join(import.meta.dirname!, "./.env");

const conf: Config = {} as Config;
function loadConf() {
  try {
    console.log("Loading config...");
    Object.assign(conf, JSON.parse(fs.readFileSync(CONFIG, "utf-8")));
  } catch (e) {
    console.error(`Error loading config.json: ${(e as Error).message}`);
  }
}
function loadEnv() {
  if (!env.PORT) {
    try {
      console.log("Loading env...");
      process.loadEnvFile(ENV);
    } catch (e) { console.error(e); }

    if (!env.PORT) throw new Error("PORT environment variable not set");
  }

  conf.port = +env.PORT;
  conf.host = env.HOST ?? "0.0.0.0";

  conf.urls = Object.fromEntries(
    Object.keys(env).map((key, _, all) => {
      const match = key.match(/^CAL(\d*)(_URL)?$/i);
      if (!match) return undefined;
      const src = match[0].toUpperCase().replace("_URL", "").concat("_SRC");
      const matches = all.filter((key) =>
        key.startsWith(src!.toUpperCase()) &&
        key.slice(src!.length).match(/^\d*$/)
      );
      return [env[key], matches.map((src) => env[src])] as [string, string[]];
    }).filter((key) => key != undefined),
  );
}

if (!fs.existsSync(CONFIG) && !fs.existsSync(ENV)) throw new Error("ENVIRONMENT variables or config.json must be set");
else if (fs.existsSync(CONFIG)) {
  loadConf();
  fs.watchFile(CONFIG, (_c, _p) => {
    console.log("Config has changed, updating...");

    loadConf();
    listen();
  });
}
else loadEnv();

// ---
type Cal = {
  timezones: ICAL.Component[];
  events: ICAL.Component[];
};
const cache = new Map<string, Cal>();
async function fetch_cal(calendar: string, idx: string, prefetch: boolean = false) {
  let timezones: ICAL.Component[] = [];
  let events: ICAL.Component[] = [];

  if (cache.has(`${idx}:${calendar}`) && !prefetch) {
    console.log(`reading from cache ${calendar}`);
    fetch_cal(calendar, idx, true);
    return cache.get(`${idx}:${calendar}`)!;
  }

  try {
    if (!prefetch) console.log(`fetching ${calendar}`);
    const ical = await (await fetch(calendar)).text();
    const i = ICAL.parse(ical);
    const ic = new ICAL.Component(i);

    timezones = ic.getAllSubcomponents("vtimezone");

    // solve common ics parsing issues https://github.com/przemub/ics_caldav_sync/pull/20
    const ic_events = ic.getAllSubcomponents("vevent").filter(component => {
      const event = new ICAL.Event(component);
      try { return !event.isRecurring() || event.iterator().next() != null; } catch (_e) { return false; }
    }).sort((a, b) => +a.hasProperty("recurrence-id") - +b.hasProperty("recurrence-id"));

    ic_events.map(component => new ICAL.Event(component)).forEach(event => event.uid = `${idx}-${event.uid}`);
    events = ic_events;

    cache.set(`${idx}:${calendar}`, { timezones, events });
  } catch (e) {
    if (!prefetch) console.log("error", e);
    if (cache.has(`${idx}:${calendar}`)) {
      if (!prefetch) console.log(`using cache for ${calendar}`);
      return cache.get(`${idx}:${calendar}`)!;
    }
  }

  return { timezones, events };
}
async function prefetch() {
  console.time("prefetch");
  const f = [];
  for (const source in conf.urls) {
    const sources = conf.urls[source];
    for (const idx in sources) {
      const calendar = sources[idx];
      f.push(fetch_cal(calendar, idx, true));
    }
  }
  await Promise.allSettled(f);
  console.timeEnd("prefetch");
}
setInterval(prefetch, 60 * 60 * 1000);
prefetch();
// ---

// Start server
const server: http.Server = http.createServer(async (req, res) => {
  let sources: string[] = [];
  switch (Object.keys(conf.urls).includes(req.url!.slice(1))) {
    case true: {
      sources = conf.urls[req.url!.slice(1)];
      break;
    }
    default: {
      res.statusCode = 404;
      res.end("not found\n");
      return;
    }
  }

  const timezones = [];
  const events = [];

  for (const idx in sources) {
    const calendar = sources[idx];
    const cal = await fetch_cal(calendar, idx);
    timezones.push(...cal.timezones);
    events.push(...cal.events);
  }

  const tzs = timezones.map(component => new ICAL.Timezone(component));
  const tzids = [...new Set(tzs.map(tz => tz.tzid))];
  const tzcs: ICAL.Component[] = [];
  for (const tzid of tzids) {
    const mtzs = tzs.filter((tz) => tz.tzid == tzid);
    if (new Set(mtzs.map((tz) => tz.toString())).size !== 1)
      console.log(`[WARN] not all timezone definitions for ${tzid} are equal, using the first definition`);

    tzcs.push(mtzs[0].component);
  }

  const cal = new ICAL.Component("vcalendar");
  [
    ["prodid", {}, "text", "-//ical.js//ical merger//EN"],
    ["version", {}, "text", "2.0"],
    ["calscale", {}, "text", "GREGORIAN"],
    ["method", {}, "text", "PUBLISH"],
  ].forEach(prop => cal.addProperty(new ICAL.Property(prop)));
  tzcs.forEach(tz => cal.addSubcomponent(tz));
  events.forEach(e => cal.addSubcomponent(e));

  res.writeHead(200, "OK", {
    "content-type": "text/calendar; charset=utf-8",
  });
  res.write(cal.toString());
  res.end();
});

const listen = () => {
  if (server.listening) server.close();

  server.listen(
    conf.port,
    conf.host,
    () => console.log(`listening ${conf.host}:${conf.port}`),
  );
};

listen();