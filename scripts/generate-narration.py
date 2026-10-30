"""Generate the demo's synthetic neural narration and timed subtitles."""
import argparse
import asyncio
import json
from pathlib import Path
import edge_tts


async def main(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    sections = json.loads(Path("docs/demo-narration.json").read_text(encoding="utf-8"))
    for section in sections:
        audio = output / (section["id"] + ".mp3")
        if audio.exists() and audio.stat().st_size:
            continue
        communicate = edge_tts.Communicate(section["text"], "en-US-AndrewNeural", rate="+5%")
        subtitles = edge_tts.SubMaker()
        with audio.open("wb") as stream:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    stream.write(chunk["data"])
                elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                    subtitles.feed(chunk)
        (output / (section["id"] + ".srt")).write_text(subtitles.get_srt(), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("runtime/demo/voice"))
    asyncio.run(main(parser.parse_args().output))
