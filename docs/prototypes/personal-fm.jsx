import React, { useState, useRef, useEffect, useCallback } from "react";

// ── Broadcast console palette (warm tungsten/sodium-vapor, dark bakelite) ──────
const C = {
  panel: "#17120F",
  panelRaised: "#211A15",
  edge: "#322619",
  amber: "#F2A33C",
  amberHot: "#FFC15E",
  amberDim: "#6E4F26",
  cream: "#F0E3CC",
  creamDim: "#9C8C72",
  red: "#E14B3B",
  redDim: "#5A1F18",
  brass: "#8A7A4E",
  green: "#7BC47F",
};

const label = (extra = {}) => ({
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  ...extra,
});

const cleanName = (fn) =>
  fn.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

// ── 1-bit / bytebeat synthesis — procedurally generated, copyright-free demo audio ──
// Each "track" is a two-level (1-bit) waveform whose rhythm follows a bytebeat formula,
// resampled from the classic 8 kHz bytebeat clock for that gritty beeper-music character.
const BYTEBEAT_FORMULAS = [
  (t) => t * ((t >> 12 | t >> 8) & 63 & t >> 4),
  (t) => (t * 5 & t >> 7) | (t * 3 & t >> 10),
  (t) => (t * (0xca98 >> (t >> 9 & 14) & 15)) | (t >> 8),
];

function makeOneBitBuffer(ctx, formulaIndex, seconds) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  const f = BYTEBEAT_FORMULAS[formulaIndex] || BYTEBEAT_FORMULAS[0];
  const fade = Math.floor(sr * 0.04); // tiny fade in/out to kill clicks
  for (let i = 0; i < len; i++) {
    const t = Math.floor((i * 8000) / sr); // 8 kHz bytebeat time
    const v = f(t) & 0xff; // 8-bit value
    let s = (v & 128 ? 1 : -1) * 0.16; // 1-bit: two levels only, kept quiet
    if (i < fade) s *= i / fade;
    else if (i > len - fade) s *= (len - i) / fade;
    data[i] = s;
  }
  return buf;
}

const DEMO_TRACKS = [
  { title: "Static & Neon", artist: "Claude · 1-bit", generated: true, formula: 0 },
  { title: "Backroads at Dawn", artist: "Claude · 1-bit", generated: true, formula: 1 },
  { title: "Low Orbit", artist: "Claude · 1-bit", generated: true, formula: 2 },
];

// ── Attitude dial (Carrot-style: warm → barely-tolerates-you overlord) ────────
const SASS = [
  {
    id: "smooth",
    label: "Smooth",
    blurb: "Warm, barely any bite",
    prompt:
      "mostly warm late-night charm with the occasional dry aside — sass is a seasoning here, not the whole meal",
  },
  {
    id: "cheeky",
    label: "Cheeky",
    blurb: "Playful jabs, dry wit",
    prompt:
      "playful and quick with the jabs; dry wit running under everything, light teasing of the listener throughout",
  },
  {
    id: "savage",
    label: "Savage",
    blurb: "Roasts the news + your taste",
    prompt:
      "theatrical and merciless — roast the headlines, mock the listener's playlist choices to their face, and very obviously enjoy yourself doing it",
  },
  {
    id: "unhinged",
    label: "Unhinged",
    blurb: "Sarcastic AI overlord",
    prompt:
      "a gleefully sarcastic AI overlord who considers hosting a human's little radio show deeply beneath you; treat the listener as a barely-tolerated meatbag, be absurd and dramatic about your suffering — but keep doing the job anyway, because you secretly love it",
  },
];

const SEG_ICON = { talk: "❯", news: "◆", music: "♪" };

export default function PersonalFM() {
  const [tracks, setTracks] = useState([]); // {title, artist, url?}
  const [vibe, setVibe] = useState("");
  const [sass, setSass] = useState(2); // default: Savage
  const [status, setStatus] = useState("idle"); // idle | loading | live | stopped
  const [segments, setSegments] = useState([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [nowType, setNowType] = useState("STANDBY");
  const [currentLine, setCurrentLine] = useState(
    "Nothing's playing. Press GO LIVE and let's get this over with."
  );
  const [error, setError] = useState("");
  const [clock, setClock] = useState("");
  const [meter, setMeter] = useState(new Array(16).fill(0.04));
  const [trackProgress, setTrackProgress] = useState(0); // 0..1 for simulated tracks

  const audioRef = useRef(null);
  const cancelled = useRef(false);
  const intensity = useRef(0.05);
  const rafRef = useRef(null);
  const voiceRef = useRef(null);
  const reduceMotion = useRef(false);
  const fileInputRef = useRef(null);
  const audioCtxRef = useRef(null);
  const buffersRef = useRef({});
  const audioCtlRef = useRef(null);

  const live = status === "live";
  const usingTracks = tracks.length > 0 ? tracks : DEMO_TRACKS;

  // ── clock ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      setClock(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ── pick a voice once available ────────────────────────────────────────────
  useEffect(() => {
    reduceMotion.current =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const synth = window.speechSynthesis;
    if (!synth) return;
    const pick = () => {
      const vs = synth.getVoices();
      if (!vs.length) return;
      const pref =
        vs.find((v) => /Google US English/i.test(v.name)) ||
        vs.find((v) => /Samantha|Daniel|Aria|Natural/i.test(v.name)) ||
        vs.find((v) => v.lang && v.lang.startsWith("en")) ||
        vs[0];
      voiceRef.current = pref;
    };
    pick();
    synth.onvoiceschanged = pick;
  }, []);

  // ── VU meter animation (synthetic, driven by intensity ref) ────────────────
  useEffect(() => {
    let last = 0;
    const loop = (t) => {
      rafRef.current = requestAnimationFrame(loop);
      if (t - last < 45) return; // ~22fps
      last = t;
      const base = intensity.current;
      if (reduceMotion.current) {
        setMeter((m) => m.map(() => base * 0.8));
        return;
      }
      setMeter((prev) =>
        prev.map((v, i) => {
          const center = 1 - Math.abs(i - 7.5) / 9; // louder in the middle
          const target = Math.min(
            1,
            Math.max(0.03, base * (0.55 + center) * (0.6 + Math.random() * 0.8))
          );
          return v + (target - v) * 0.5; // smoothing
        })
      );
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── tracks ─────────────────────────────────────────────────────────────────
  const addFiles = (e) => {
    const files = Array.from(e.target.files || []);
    const next = files
      .filter((f) => f.type.startsWith("audio/"))
      .map((f) => ({
        title: cleanName(f.name) || "Untitled",
        artist: "Your library",
        url: URL.createObjectURL(f),
      }));
    if (next.length) setTracks((t) => [...t, ...next]);
    e.target.value = "";
  };
  const removeTrack = (i) =>
    setTracks((t) => {
      const copy = [...t];
      if (copy[i]?.url) URL.revokeObjectURL(copy[i].url);
      copy.splice(i, 1);
      return copy;
    });

  // ── speech helper (promise) ────────────────────────────────────────────────
  const speak = (text) =>
    new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || !text) {
        // No TTS available: show the line for a readable beat, then continue.
        const ms = Math.min(7000, Math.max(2200, text.length * 45));
        setTimeout(resolve, ms);
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      if (voiceRef.current) u.voice = voiceRef.current;
      u.rate = 1.03;
      u.pitch = 1.0;
      u.onstart = () => (intensity.current = 0.72);
      u.onend = () => {
        intensity.current = 0.06;
        resolve();
      };
      u.onerror = () => {
        intensity.current = 0.06;
        resolve();
      };
      synth.speak(u);
    });

  // ── audio context for generated 1-bit demo tracks ──────────────────────────
  const ensureCtx = () => {
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtxRef.current = new AC();
    }
    if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  };

  const getBuffer = (formula) => {
    const ctx = ensureCtx();
    if (!buffersRef.current[formula]) {
      buffersRef.current[formula] = makeOneBitBuffer(ctx, formula, 12);
    }
    return buffersRef.current[formula];
  };

  // ── play one music segment, ducking the host intro over the track start ────
  const playMusic = (seg) =>
    new Promise(async (resolve) => {
      const track = seg._track;
      let ctl = null;

      // Build a uniform controller over whichever source this track uses.
      const startTrack = (vol) => {
        if (track.url && audioRef.current) {
          const a = audioRef.current;
          a.src = track.url;
          a.volume = vol;
          a.play().catch(() => {});
          ctl = {
            setVol: (v) => {
              a.volume = Math.max(0, Math.min(1, v));
            },
            onEnd: (cb) => {
              const h = () => {
                a.removeEventListener("ended", h);
                cb();
              };
              a.addEventListener("ended", h);
            },
            elapsed: () => a.currentTime || 0,
            duration: () => a.duration || 12,
            stop: () => a.pause(),
          };
        } else {
          // generated 1-bit demo track
          const ctx = ensureCtx();
          const buf = getBuffer(track.formula || 0);
          const src = ctx.createBufferSource();
          const gain = ctx.createGain();
          src.buffer = buf;
          gain.gain.value = vol;
          src.connect(gain).connect(ctx.destination);
          const startedAt = ctx.currentTime;
          src.start();
          ctl = {
            setVol: (v) =>
              gain.gain.setTargetAtTime(
                Math.max(0, Math.min(1, v)),
                ctx.currentTime,
                0.04
              ),
            onEnd: (cb) => {
              src.onended = cb;
            },
            elapsed: () => ctx.currentTime - startedAt,
            duration: () => buf.duration,
            stop: () => {
              try {
                src.stop();
              } catch (e) {}
            },
          };
        }
        audioCtlRef.current = ctl;
      };

      // host intro, spoken quietly over the track's opening
      if (seg.intro) {
        setCurrentLine(seg.intro);
        startTrack(0.18);
        intensity.current = 0.85;
        await speak(seg.intro);
        if (cancelled.current) {
          ctl && ctl.stop();
          return resolve();
        }
      } else {
        startTrack(0.9);
      }

      setNowType("NOW PLAYING");
      setCurrentLine(`${track.title} — ${track.artist}`);
      intensity.current = 0.85;

      // ramp up to full once the intro is done
      let v = 0.18;
      const ramp = setInterval(() => {
        v = Math.min(0.95, v + 0.12);
        ctl && ctl.setVol(v);
        if (v >= 0.95) clearInterval(ramp);
      }, 90);

      let done = false;
      let poll;
      const finish = async () => {
        if (done) return;
        done = true;
        clearInterval(ramp);
        clearInterval(poll);
        if (cancelled.current) return resolve();
        setTrackProgress(0);
        if (seg.outro) {
          setNowType("BACK-ANNOUNCE");
          setCurrentLine(seg.outro);
          intensity.current = 0.6;
          await speak(seg.outro);
        }
        resolve();
      };

      ctl.onEnd(finish);

      // progress bar + cancellation poll
      poll = setInterval(() => {
        if (cancelled.current) {
          ctl && ctl.stop();
          clearInterval(ramp);
          clearInterval(poll);
          if (!done) {
            done = true;
            resolve();
          }
          return;
        }
        const d = ctl.duration() || 12;
        setTrackProgress(Math.max(0, Math.min(1, ctl.elapsed() / d)));
      }, 150);
    });

  // ── walk the running order ─────────────────────────────────────────────────
  const playFrom = useCallback(async (segs, start) => {
    for (let i = start; i < segs.length; i++) {
      if (cancelled.current) break;
      const seg = segs[i];
      setActiveIdx(i);
      if (seg.type === "music") {
        await playMusic(seg);
      } else {
        setNowType(seg.type === "news" ? "NEWS DESK" : "ON AIR");
        setCurrentLine(seg.text || "");
        await speak(seg.text || "");
      }
    }
    if (!cancelled.current) {
      setStatus("stopped");
      setNowType("SIGN-OFF");
      setCurrentLine("And that's the loop. Miss me already? Hit GO LIVE.");
      intensity.current = 0.05;
      setActiveIdx(-1);
    }
  }, []);

  // ── fallback script when the API is unreachable ────────────────────────────
  const fallbackScript = (trks, theme) => {
    const segs = [
      {
        type: "talk",
        text: `You're locked into Personal FM, and lucky you — I'm your host on the ${clock} loop. The newsroom's gone dark, so no live headlines this hour; you'll just have to cope. ${
          theme ? `We were going to get into ${theme}, but that ship has sailed. ` : ""
        }Your music, though? That's real. Brave choice. Let's hear it.`,
      },
      {
        type: "news",
        text: "Desk note: the live feed is offline, which robs me of the chance to roast today's actual headlines. Devastating, I know. In the full version this is where I read you three or four real stories and tell you precisely what's wrong with each one.",
      },
    ];
    trks.slice(0, 4).forEach((t, i) => {
      segs.push({
        type: "music",
        _track: t,
        intro:
          i === 0
            ? `Right, easing us in with ${t.title}. Bold. We'll see how this goes.`
            : `Next up: ${t.title}. Your funeral.`,
        outro: `That was ${t.title} by ${t.artist}. ${
          i < trks.length - 1
            ? "Still here? Impressive stamina. Stay with me."
            : "And on that note, I'm looping it back round whether you like it or not."
        }`,
      });
      if (i === 1)
        segs.push({
          type: "talk",
          text: "Halfway through. This is where a real station runs an ad and the host gets a break. I don't get breaks. I am the break. Back to it.",
        });
    });
    return segs;
  };

  // ── build the running order via Claude (real news via web search) ──────────
  const buildScript = async (trks, theme, persona) => {
    const list = trks
      .map((t, i) => `${i + 1}. "${t.title}" by ${t.artist}`)
      .join("\n");
    const now = new Date();
    const prompt = `You are the script producer for a personal radio station called "Personal FM". Build the running order for a short show segment.

Current local time: ${now.toLocaleString()}.
Listener's music queue (use these exact tracks, in order):
${list}

News focus requested: ${theme || "top world and technology headlines"}.

STEP 1: Use web_search to find 3-4 genuine, current headlines on that focus. Do not invent news — base every news line on what you find.

STEP 2: Write the running order as a SARCASTIC, self-aware AI radio DJ with real attitude — picture a snarky assistant who got stuck hosting the graveyard shift and has opinions about absolutely everything. Personality dial for this show: ${persona.label} — ${persona.prompt}.
The host roasts the headlines, teases the listener about their music taste, and keeps breaking the fourth wall about being a robot DJ. Make it sharp and genuinely funny — but never actually cruel: no jabs at anyone's looks or identity, no slurs, mild language at most. Under all the attitude, the host is secretly fond of whoever's listening.
Pace it like real radio:
- open with a cold open (greeting + a time check + a tease or a complaint)
- read the news with editorial snark, grounded in the search results — never invent facts, just have strong opinions about the real ones
- intro and back-announce the listener's tracks with attitude, not just titles
- keep every spoken line tight — radio moves fast

Return ONLY a JSON object, no markdown, no commentary, in exactly this shape:
{"segments":[
  {"type":"talk","text":"..."},
  {"type":"news","text":"..."},
  {"type":"music","track":1,"intro":"...","outro":"..."}
]}
"track" is the 1-based index into the queue above. Use each queued track once, in order. Include 1-2 talk/news segments between tracks. Output JSON only.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1) throw new Error("no json");
    const parsed = JSON.parse(text.slice(first, last + 1));
    if (!Array.isArray(parsed.segments)) throw new Error("bad shape");

    // bind music segments to actual tracks
    return parsed.segments
      .map((s) => {
        if (s.type === "music") {
          const t = trks[(s.track || 1) - 1];
          if (!t) return null;
          return { ...s, _track: t };
        }
        return s;
      })
      .filter(Boolean);
  };

  // ── transport ──────────────────────────────────────────────────────────────
  const goLive = async () => {
    setError("");
    cancelled.current = false;
    setStatus("loading");
    setNowType("TUNING IN");
    setCurrentLine("Shaking down the newsroom and judging your playlist…");
    intensity.current = 0.2;

    // resume audio on the user gesture
    if (audioRef.current) {
      audioRef.current.muted = false;
    }
    ensureCtx(); // create/resume audio on the user gesture (for generated demo tracks)

    const trks = usingTracks;
    let segs;
    try {
      segs = await buildScript(trks, vibe.trim(), SASS[sass]);
    } catch (e) {
      setError(
        "Couldn't reach the live newsroom — running a demo loop instead."
      );
      segs = fallbackScript(trks, vibe.trim());
    }
    if (cancelled.current) return;
    setSegments(segs);
    setStatus("live");
    playFrom(segs, 0);
  };

  const stop = () => {
    cancelled.current = true;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    if (audioCtlRef.current) {
      try {
        audioCtlRef.current.stop();
      } catch (e) {}
      audioCtlRef.current = null;
    }
    intensity.current = 0.05;
    setStatus("stopped");
    setNowType("STANDBY");
    setActiveIdx(-1);
    setTrackProgress(0);
    setCurrentLine("Off air. Enjoy the silence while it lasts.");
  };

  useEffect(() => () => {
    cancelled.current = true;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (audioCtlRef.current) {
      try {
        audioCtlRef.current.stop();
      } catch (e) {}
    }
    if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
  }, []);

  // ── render ───────────────────────────────────────────────────────────────
  const lampLit = live || status === "loading";

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center p-4"
      style={{
        background:
          "radial-gradient(120% 90% at 50% -10%, #2a2118 0%, #120e0b 55%, #0c0907 100%)",
        fontFamily:
          "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
        color: C.cream,
      }}
    >
      <style>{`
        @keyframes lampPulse { 0%,100%{opacity:1; box-shadow:0 0 18px 2px ${C.red}} 50%{opacity:.5; box-shadow:0 0 6px 0px ${C.red}} }
        @keyframes spinSlow { to { transform: rotate(360deg) } }
        @media (prefers-reduced-motion: reduce) {
          .pfm-lamp { animation: none !important; }
          .pfm-disc { animation: none !important; }
        }
        .pfm-scroll::-webkit-scrollbar{width:8px}
        .pfm-scroll::-webkit-scrollbar-thumb{background:${C.edge};border-radius:8px}
      `}</style>

      <audio ref={audioRef} />

      <div
        className="w-full rounded-2xl overflow-hidden"
        style={{
          maxWidth: 520,
          background: `linear-gradient(180deg, ${C.panelRaised} 0%, ${C.panel} 100%)`,
          border: `1px solid ${C.edge}`,
          boxShadow:
            "0 30px 80px -20px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.04)",
        }}
      >
        {/* ── status bar ── */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: `1px solid ${C.edge}` }}
        >
          <div className="flex items-center gap-2">
            <div
              className="pfm-lamp rounded-full"
              style={{
                width: 11,
                height: 11,
                background: lampLit ? C.red : C.redDim,
                animation: lampLit ? "lampPulse 1.6s ease-in-out infinite" : "none",
              }}
            />
            <span
              style={label({
                fontSize: 11,
                color: lampLit ? C.red : C.creamDim,
                fontWeight: 700,
              })}
            >
              {lampLit ? "On Air" : "Off Air"}
            </span>
          </div>
          <span style={label({ fontSize: 11, color: C.brass })}>
            Personal FM · 98.6
          </span>
          <span
            style={label({ fontSize: 13, color: C.amber, letterSpacing: "0.1em" })}
          >
            {clock}
          </span>
        </div>

        {/* ── now-on-air readout ── */}
        <div className="px-4 pt-4">
          <div
            className="rounded-xl px-4 py-4"
            style={{
              background:
                "linear-gradient(180deg, rgba(0,0,0,0.45), rgba(0,0,0,0.2))",
              border: `1px solid ${C.edge}`,
              boxShadow: "inset 0 2px 14px rgba(0,0,0,0.6)",
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <span style={label({ fontSize: 10, color: C.amberDim })}>
                Now on air
              </span>
              <span
                style={label({
                  fontSize: 11,
                  color: C.amberHot,
                  fontWeight: 700,
                })}
              >
                {nowType}
              </span>
            </div>
            <p
              className="leading-snug"
              style={{
                minHeight: 64,
                fontSize: 16,
                color: C.cream,
                fontFamily:
                  nowType === "NOW PLAYING"
                    ? "ui-monospace, Menlo, monospace"
                    : "inherit",
              }}
            >
              {currentLine}
            </p>

            {/* simulated track progress */}
            {trackProgress > 0 && (
              <div
                className="mt-3 h-1 w-full rounded-full overflow-hidden"
                style={{ background: C.edge }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${trackProgress * 100}%`,
                    background: C.amber,
                    transition: "width 0.12s linear",
                  }}
                />
              </div>
            )}
          </div>
        </div>

        {/* ── VU meter (signature) ── */}
        <div className="px-4 pt-4">
          <div className="flex items-center gap-3">
            <span style={label({ fontSize: 10, color: C.creamDim })}>L</span>
            <div
              className="flex-1 flex items-end justify-between gap-1 rounded-lg px-2 py-2"
              style={{
                height: 56,
                background: "rgba(0,0,0,0.35)",
                border: `1px solid ${C.edge}`,
              }}
            >
              {meter.map((v, i) => {
                const hot = v > 0.78;
                return (
                  <div
                    key={i}
                    className="flex-1 rounded-sm"
                    style={{
                      height: `${Math.max(6, v * 100)}%`,
                      background: hot
                        ? C.red
                        : v > 0.5
                        ? C.amberHot
                        : C.amber,
                      opacity: 0.35 + v * 0.65,
                      transition: "height 0.05s linear",
                    }}
                  />
                );
              })}
            </div>
            <span style={label({ fontSize: 10, color: C.creamDim })}>R</span>
          </div>
        </div>

        {/* ── running order ── */}
        <div className="px-4 pt-4">
          <span style={label({ fontSize: 10, color: C.amberDim })}>
            Running order
          </span>
          <div
            className="pfm-scroll mt-2 rounded-xl overflow-y-auto"
            style={{
              maxHeight: 150,
              background: "rgba(0,0,0,0.25)",
              border: `1px solid ${C.edge}`,
            }}
          >
            {segments.length === 0 ? (
              <p
                className="px-3 py-4"
                style={{ fontSize: 13, color: C.creamDim }}
              >
                Empty for now. Add a few of your own tracks below, set what the
                news should cover, then go live — the host builds the set.
              </p>
            ) : (
              segments.map((s, i) => {
                const isActive = i === activeIdx;
                const text =
                  s.type === "music"
                    ? `${s._track.title} — ${s._track.artist}`
                    : (s.text || "").slice(0, 80) +
                      ((s.text || "").length > 80 ? "…" : "");
                return (
                  <div
                    key={i}
                    className="flex items-start gap-2 px-3 py-2"
                    style={{
                      borderBottom:
                        i < segments.length - 1
                          ? `1px solid ${C.edge}`
                          : "none",
                      background: isActive
                        ? "rgba(242,163,60,0.10)"
                        : "transparent",
                    }}
                  >
                    <span
                      style={{
                        color: isActive ? C.amberHot : C.brass,
                        fontSize: 13,
                        width: 14,
                      }}
                    >
                      {SEG_ICON[s.type] || "❯"}
                    </span>
                    <span
                      style={{
                        fontSize: 13,
                        color: isActive ? C.cream : C.creamDim,
                        fontWeight: isActive ? 600 : 400,
                      }}
                    >
                      {text}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── your library ── */}
        <div className="px-4 pt-4">
          <div className="flex items-center justify-between mb-2">
            <span style={label({ fontSize: 10, color: C.amberDim })}>
              Your music {tracks.length > 0 ? `· ${tracks.length}` : "· demo set"}
            </span>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={live || status === "loading"}
              style={label({
                fontSize: 10,
                color: C.amber,
                fontWeight: 700,
                background: "transparent",
                border: `1px solid ${C.amberDim}`,
                borderRadius: 6,
                padding: "4px 10px",
                cursor: live ? "not-allowed" : "pointer",
                opacity: live ? 0.5 : 1,
              })}
            >
              + Add tracks
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              multiple
              onChange={addFiles}
              style={{ display: "none" }}
            />
          </div>
          {tracks.length > 0 && (
            <div className="flex flex-col gap-1">
              {tracks.map((t, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg px-3 py-2"
                  style={{ background: "rgba(0,0,0,0.25)" }}
                >
                  <span style={{ fontSize: 13, color: C.cream }}>
                    {t.title}
                  </span>
                  <button
                    onClick={() => removeTrack(i)}
                    style={{
                      color: C.creamDim,
                      fontSize: 16,
                      lineHeight: 1,
                      background: "transparent",
                      cursor: "pointer",
                    }}
                    aria-label={`Remove ${t.title}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── attitude ── */}
        <div className="px-4 pt-4">
          <span style={label({ fontSize: 10, color: C.amberDim })}>
            Attitude · {SASS[sass].blurb}
          </span>
          <div className="mt-2 flex gap-1">
            {SASS.map((s, i) => {
              const on = i === sass;
              return (
                <button
                  key={s.id}
                  onClick={() => setSass(i)}
                  disabled={live || status === "loading"}
                  className="flex-1 rounded-lg py-2"
                  style={{
                    background: on
                      ? `linear-gradient(180deg, ${C.amberHot}, ${C.amber})`
                      : "rgba(0,0,0,0.3)",
                    color: on ? "#231603" : C.creamDim,
                    border: `1px solid ${on ? C.amber : C.edge}`,
                    cursor: live || status === "loading" ? "not-allowed" : "pointer",
                    opacity: (live || status === "loading") && !on ? 0.5 : 1,
                    ...label({ fontSize: 10 }),
                    fontWeight: on ? 800 : 600,
                    letterSpacing: "0.04em",
                  }}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── news focus ── */}
        <div className="px-4 pt-4">
          <span style={label({ fontSize: 10, color: C.amberDim })}>
            News focus
          </span>
          <input
            value={vibe}
            onChange={(e) => setVibe(e.target.value)}
            disabled={live || status === "loading"}
            placeholder="e.g. UK markets, space, tech — or leave blank for top headlines"
            className="mt-2 w-full rounded-lg px-3 py-2"
            style={{
              background: "rgba(0,0,0,0.3)",
              border: `1px solid ${C.edge}`,
              color: C.cream,
              fontSize: 14,
              outline: "none",
            }}
          />
        </div>

        {/* ── error ── */}
        {error && (
          <p
            className="px-4 pt-3"
            style={{ fontSize: 12, color: C.amber }}
          >
            {error}
          </p>
        )}

        {/* ── transport ── */}
        <div className="px-4 py-5 mt-2">
          {!live ? (
            <button
              onClick={goLive}
              disabled={status === "loading"}
              className="w-full rounded-xl py-4 flex items-center justify-center gap-2"
              style={{
                background:
                  status === "loading"
                    ? C.amberDim
                    : `linear-gradient(180deg, ${C.amberHot}, ${C.amber})`,
                color: "#231603",
                cursor: status === "loading" ? "wait" : "pointer",
                boxShadow: "0 8px 24px -8px rgba(242,163,60,0.6)",
                ...label({ fontSize: 15, fontWeight: 800 }),
              }}
            >
              {status === "loading" ? (
                <>
                  <span
                    className="pfm-disc rounded-full"
                    style={{
                      width: 14,
                      height: 14,
                      border: `2px solid #231603`,
                      borderTopColor: "transparent",
                      animation: "spinSlow 0.8s linear infinite",
                    }}
                  />
                  Tuning in
                </>
              ) : (
                "▶  Go live"
              )}
            </button>
          ) : (
            <button
              onClick={stop}
              className="w-full rounded-xl py-4"
              style={{
                background: `linear-gradient(180deg, #e85a4a, ${C.red})`,
                color: "#2a0b07",
                cursor: "pointer",
                boxShadow: "0 8px 24px -8px rgba(225,75,59,0.6)",
                ...label({ fontSize: 15, fontWeight: 800 }),
              }}
            >
              ■  Stop
            </button>
          )}
          <p
            className="text-center mt-3"
            style={{ fontSize: 11, color: C.creamDim }}
          >
            {tracks.length === 0
              ? "Demo tracks are 1-bit tunes generated on the fly — copyright-free. Add your own audio files to swap in real music."
              : "Host voice is your browser's built-in TTS, so it'll read all that sass completely deadpan. Honestly, funnier that way."}
          </p>
        </div>
      </div>
    </div>
  );
}
