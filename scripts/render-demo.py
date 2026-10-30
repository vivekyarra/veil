"""Edit actual screen recordings with neural narration; never synthesize product states."""
from pathlib import Path
import json
import re
import subprocess
import textwrap

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "runtime/demo"
OUT = ROOT / "artifacts"
OUT.mkdir(exist_ok=True)
EDIT = DEMO / "edit"
EDIT.mkdir(exist_ok=True)
FFMPEG = Path.home() / "Downloads/ffmpeg-8.1.1-essentials_build/bin/ffmpeg.exe"
APP = Path(json.loads((DEMO / "recording.json").read_text())["videoPath"])
NATIVE = DEMO / "raw/2026-10-30 07-36-10.mkv"
CODEX = Path(json.loads((DEMO / "codex-video.json").read_text())["outputPath"])
ARCH = Path(json.loads((DEMO / "architecture-video.json").read_text())["outputPath"])
ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]

def run(args):
    with (DEMO / "render.log").open("a", encoding="utf-8") as log:
        subprocess.run([str(FFMPEG), "-hide_banner", "-y", *map(str, args)], cwd=ROOT,
                       check=True, stdout=log, stderr=log)

# Browser screenshots are consecutive real-time screen samples, not slide assets.
frames = DEMO / "twitch-live-frames"
times = json.loads((frames / "timing.json").read_text())
frame_list = EDIT / "twitch-frames.txt"
lines = []
for i, start in enumerate(times):
    lines += [f"file '{(frames / f'{i:05}.png').as_posix()}'",
              f"duration {(times[i + 1] - start) if i + 1 < len(times) else .12:.6f}"]
lines += [f"file '{(frames / f'{len(times)-1:05}.png').as_posix()}'"]
frame_list.write_text("\n".join(lines), encoding="utf-8")
TWITCH = EDIT / "twitch-browser.mp4"
run(["-f", "concat", "-safe", "0", "-i", frame_list, "-vf",
     "fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
     *ENCODE, "-an", TWITCH])
NATIVE_REPLAY = EDIT / "native-replay.mp4"
run(["-ss", "4.2", "-t", "1.8", "-i", NATIVE, "-vf", "setpts=5*(PTS-STARTPTS),fps=30",
     *ENCODE, "-an", NATIVE_REPLAY])

# Screen recordings play normally except the explicitly labeled native replay.
# The black opening is empty for the participant's separately supplied clip.
plan = [
    ("problem", 12, [(APP, 250, 12)], "ONE FRAME. A PRIVATE DETAIL. A PUBLIC AUDIENCE."),
    ("prevent", 12, [(APP, 251, 2), (NATIVE_REPLAY, 0, 9), (NATIVE, 20, 1)], "REAL OBS OUTPUT | 0.2X REPLAY | PARANOID HOLDS LATE FRAMES"),
    ("safe", 12, [(APP, 638, 12)], "CPU TIMING LIMIT | PARANOID COVERS UNVERIFIED FRAMES"),
    ("vault", 13, [(APP, 496, 6), (APP, 762, 7)], "NEVER SHOW | ENCRYPTED LOCALLY | SEPARATE TWITCH OPT-IN"),
    ("connect", 15, [(APP, 251, 3), (TWITCH, 0, 12)], "REAL TWITCH BROADCAST | YARRAVIVEK | 720P"),
    ("contain", 14, [(APP, 311, 14)], "REAL PANIC ACTION | OBS COVER + TWITCH VOD MARKER"),
    ("guard", 14, [(APP, 935, 7), (APP, 557, 7)], "LIVE MATCH VERIFIED | BROADCASTER MESSAGE PRODUCES A WARNING"),
    ("report", 13, [(APP, 557, 8), (APP, 630, 5)], "REAL INCIDENT | MARKER AT 111 S | PRIVATE TEXT OMITTED"),
    ("architecture", 14, [(ARCH, 5, 14)], "EXPLANATORY ANIMATION | ACTUAL TECHNOLOGIES USED"),
    ("proof", 15, [(CODEX, 5, 15)], "3,000 IMAGE TEST | CARD RECALL 99.77% | NEGATIVE FPR 0.47%"),
    ("close", 10, [(APP, 936, 10)], "VEIL | STREAM WITH BOUNDARIES | BUILT WITH CODEX"),
]

def stamp(value):
    millis = round(value * 1000)
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    seconds, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"

def parse_stamp(value):
    h, m, s, ms = map(int, re.split("[:,]", value))
    return h * 3600 + m * 60 + s + ms / 1000

subtitle_blocks = []
timeline = []
offset = 8.0
for name, duration, parts, label in plan:
    print(f"Encoding real footage: {name}", flush=True)
    inputs = []
    filters = []
    for i, (source, start, length) in enumerate(parts):
        inputs += ["-ss", start, "-t", length, "-i", source]
        filters += [f"[{i}:v]fps=30,scale=1680:880:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:70,setsar=1,setpts=PTS-STARTPTS[v{i}]"]
    concat = "".join(f"[v{i}]" for i in range(len(parts)))
    filters += [f"{concat}concat=n={len(parts)}:v=1:a=0[base]"]
    # A single top label and sentence captions keep the original UI visible.
    ass = EDIT / f"{name}.ass"
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Segoe UI,38,&H00FFFFFF,&H00FFFFFF,&H0010180B,&H0010180B,0,0,0,0,100,100,0,0,3,2,0,2,120,120,35,1
Style: Label,Segoe UI,25,&H009CF3BD,&H009CF3BD,&H0010180B,&H0010180B,-1,0,0,0,100,100,1,0,3,2,0,8,30,30,18,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    def ass_time(seconds):
        value = stamp(seconds).replace(",", ".")[:-1]
        return str(int(value[:2])) + value[2:]
    events = [f"Dialogue: 1,0:00:00.00,0:00:{duration:05.2f},Label,,0,0,0,,{label}"]
    srt = (DEMO / f"voice/{name}.srt").read_text(encoding="utf-8-sig")
    for block in re.split(r"\n\s*\n", srt.strip()):
        rows = block.splitlines()
        if len(rows) < 3:
            continue
        begin, end = rows[1].split(" --> ")
        begin_s = parse_stamp(begin) / .95 + .65
        end_s = min(duration, parse_stamp(end) / .95 + .65)
        text = " ".join(rows[2:])
        wrapped = r"\N".join(textwrap.wrap(text, 72))
        events.append(f"Dialogue: 2,{ass_time(begin_s)},{ass_time(end_s)},Default,,0,0,0,,{wrapped}")
        subtitle_blocks.append(f"{len(subtitle_blocks)+1}\n{stamp(offset+begin_s)} --> {stamp(offset+end_s)}\n" + "\n".join(textwrap.wrap(text, 72)))
    ass.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    filters += [f"[base]subtitles='{ass.relative_to(ROOT).as_posix()}'[out]"]
    audio_index = len(parts)
    filters += [f"[{audio_index}:a]atempo=0.95,adelay=650|650,apad,atrim=duration={duration}[voice]"]
    target = EDIT / f"{name}.mp4"
    run([*inputs, "-i", DEMO / f"voice/{name}.mp3", "-filter_complex", ";".join(filters),
         "-map", "[out]", "-map", "[voice]", "-t", duration, *ENCODE,
         "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k", target])
    timeline.append({"id": name, "start_seconds": offset, "duration_seconds": duration,
                     "source_segments": [{"file": str(p), "start": s, "duration": d} for p, s, d in parts]})
    offset += duration

intro = EDIT / "opening.mp4"
run(["-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=30:d=8", "-f", "lavfi", "-i",
     "anullsrc=r=48000:cl=stereo", "-t", "8", *ENCODE, "-c:a", "aac", "-b:a", "160k", intro])
concat_file = EDIT / "final.txt"
concat_file.write_text("\n".join(f"file '{p.as_posix()}'" for p in [intro, *[EDIT / f"{p[0]}.mp4" for p in plan]]), encoding="utf-8")
assembled = EDIT / "assembled.mp4"
run(["-f", "concat", "-safe", "0", "-i", concat_file, "-c", "copy", assembled])
run(["-i", assembled, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
     "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-movflags", "+faststart", OUT / "veil-demo.mp4"])
(OUT / "veil-demo.srt").write_text("\n\n".join(subtitle_blocks) + "\n", encoding="utf-8")
(OUT / "veil-demo-timeline.json").write_text(json.dumps({"opening_black_seconds": 8, "duration_seconds": offset,
    "voice": "Microsoft en-US-AndrewNeural, AI generated", "native_replay": {"source_start":4.2,"source_seconds":1.8,"playback_speed":0.2,"explicitly_labeled":True}, "sections": timeline}, indent=2), encoding="utf-8")
assert offset < 180
print(f"Created {OUT / 'veil-demo.mp4'} ({offset:.1f} seconds)", flush=True)
