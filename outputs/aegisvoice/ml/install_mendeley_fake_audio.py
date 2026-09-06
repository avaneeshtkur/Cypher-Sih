"""Verify and register Mendeley Fake Audio Dataset V1 for offline evaluation.

The corpus is synthetic-only, so it is never mixed into fraud-intent training and
never treated as a two-class authenticity benchmark.  It is registered as an
external TTS/V2V challenge set and eight stratified WAVs are copied into the Call
Desk catalogue for direct Pella/AASIST inspection.
"""
import hashlib, json, re, shutil, wave, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

APP = Path(__file__).resolve().parents[1]
WORK = APP.parents[1] / "work"
DATASET = WORK / "datasets" / "mendeley-fake-audio-v1"
ARCHIVE = DATASET / "Fake_ElevenLabs_Respeecher.zip"
WORKBOOK = DATASET / "metadata.xlsx"
EXTRACTED = DATASET / "extracted"
AUDIO_ROOT = EXTRACTED / "Fake_ElevenLabs_Respeecher"
CATALOGUE = APP / "database-audio"
SOURCE_URL = "https://data.mendeley.com/datasets/79g59sp69z/1"
DOI = "10.17632/79g59sp69z.1"
EXPECTED = {
    ARCHIVE: "4ff7910fa37dd4af6fb897a1fc8051936c25eaefbdfa288c43c4d93875e05cb1",
    WORKBOOK: "4676c37940e903ab503b2839310370e62307cb0bcb46e92c93615c76d12b3edb",
}

def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()

def extract_verified():
    for path, expected in EXPECTED.items():
        if not path.is_file() or sha256(path) != expected:
            raise ValueError(f"Hash verification failed: {path}")
    EXTRACTED.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(ARCHIVE) as archive:
        root = EXTRACTED.resolve()
        for member in archive.infolist():
            destination = (EXTRACTED / member.filename).resolve()
            if not destination.is_relative_to(root):
                raise ValueError(f"Unsafe archive member: {member.filename}")
            if not destination.exists():
                archive.extract(member, EXTRACTED)

def workbook_rows():
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with zipfile.ZipFile(WORKBOOK) as book:
        shared = []
        if "xl/sharedStrings.xml" in book.namelist():
            tree = ET.fromstring(book.read("xl/sharedStrings.xml"))
            shared = ["".join(node.itertext()) for node in tree.findall(f"{ns}si")]
        sheet = ET.fromstring(book.read("xl/worksheets/sheet1.xml"))
    values = []
    for row in sheet.findall(f".//{ns}row"):
        mapped = {}
        for cell in row.findall(f"{ns}c"):
            column = 0
            for char in re.match(r"[A-Z]+", cell.attrib["r"]).group():
                column = column * 26 + ord(char) - 64
            value = cell.find(f"{ns}v")
            raw = "" if value is None else value.text or ""
            if cell.attrib.get("t") == "s": raw = shared[int(raw)]
            elif cell.attrib.get("t") == "inlineStr": raw = "".join(cell.itertext())
            mapped[column - 1] = raw
        values.append([mapped.get(index, "") for index in range(7)])
    header, *body = values
    expected = ["Audio", "Tool", "Type", "Gender", "Age_group", "Fs", "Time(s)"]
    if header != expected:
        raise ValueError(f"Unexpected metadata columns: {header}")
    return [dict(zip(expected, row)) for row in body if row[0]]

def validate_records(rows):
    if len(rows) != 600 or len({row["Audio"] for row in rows}) != 600:
        raise ValueError("Expected 600 unique metadata records")
    records = []
    for row in rows:
        filename = f'{row["Audio"]}.wav'
        path = AUDIO_ROOT / filename
        if not path.is_file(): raise FileNotFoundError(path)
        with wave.open(str(path), "rb") as audio:
            rate, frames, channels, width = audio.getframerate(), audio.getnframes(), audio.getnchannels(), audio.getsampwidth()
        expected_rate, expected_duration = int(float(row["Fs"])), float(row["Time(s)"])
        duration = frames / rate
        if channels != 1 or width not in (2, 3, 4) or not 1 <= duration <= 60:
            raise ValueError(f"Audio metadata mismatch: {filename}")
        records.append({
            "id": f'mendeley-{row["Audio"]}', "filename": filename,
            "tool": row["Tool"], "generationType": row["Type"], "gender": row["Gender"],
            "ageGroup": "adult" if row["Age_group"] in ("adulto", "aduto") else "older" if row["Age_group"] == "mayor" else "minor",
            "sampleRate": rate, "sampleWidthBits": width * 8, "channels": channels,
            "publisherSampleRate": expected_rate,
            "sampleRateMatchesPublisher": rate == expected_rate,
            "duration": duration, "publisherDuration": expected_duration,
            "durationMatchesPublisher": abs(duration - expected_duration) <= 1.1,
            "bytes": path.stat().st_size,
            "label": "synthetic", "source": "Mendeley Fake Audio Dataset (ElevenLabs & Respeecher)",
            "sourceUrl": SOURCE_URL, "doi": DOI, "license": "CC BY 4.0",
            "relativePath": str(path.relative_to(WORK)).replace("\\", "/"),
        })
    return records

def install_showcase(records):
    chosen = []
    for tool in ("ElevenLabs", "Respeecher"):
        for kind in ("TTS", "V2V"):
            group = [row for row in records if row["tool"] == tool and row["generationType"] == kind]
            for gender in ("F", "M"):
                chosen.append(next(row for row in group if row["gender"] == gender))
    manifest_path = CATALOGUE / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    manifest["samples"] = [row for row in manifest["samples"] if not row["id"].startswith("mendeley-")]
    for index, record in enumerate(chosen, 1):
        destination_name = f"mendeley-fake-{index:02d}.wav"
        source = WORK / record["relativePath"]
        destination = CATALOGUE / destination_name
        shutil.copy2(source, destination)
        manifest["samples"].append({
            "id": f"mendeley-fake-{index}",
            "title": f'{record["tool"]} {record["generationType"]} synthetic voice {index}',
            "file": destination_name,
            "source": record["source"], "sourceUrl": SOURCE_URL,
            "provenance": f'Publisher-labelled synthetic {record["generationType"]} audio generated with {record["tool"]}',
            "voiceOrigin": "Synthetic/deepfake (publisher label)",
            "fraudContext": "No fraud label; use for Pella/AASIST synthetic-voice analysis",
            "language": "unspecified", "license": "CC BY 4.0", "doi": DOI,
            "generator": record["tool"], "generationType": record["generationType"],
            "gender": record["gender"], "ageGroup": record["ageGroup"],
            "bytes": destination.stat().st_size, "sha256": sha256(destination),
        })
    status = [row for row in manifest.get("sourceStatus", []) if row.get("name") != "Mendeley Fake Audio Dataset (ElevenLabs & Respeecher)"]
    status.append({"name": "Mendeley Fake Audio Dataset (ElevenLabs & Respeecher)", "status": "installed",
                   "count": len(chosen), "fullLocalCount": len(records),
                   "kind": "publisher-labelled synthetic TTS and V2V audio",
                   "reason": "Eight stratified Call Desk samples; all 600 verified WAVs retained locally for deepfake evaluation."})
    manifest["sourceStatus"] = status
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return chosen

def update_source_manifest():
    path = APP / "models" / "sources.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest["files"] = [row for row in manifest["files"] if not row["name"].startswith("mendeley-fake-audio/")]
    manifest["files"].extend([
        {"name": "mendeley-fake-audio/Fake_ElevenLabs_Respeecher.zip", "url": SOURCE_URL,
         "path": str(ARCHIVE.relative_to(WORK)).replace("\\", "/"), "bytes": ARCHIVE.stat().st_size,
         "sha256": EXPECTED[ARCHIVE], "license": "CC BY 4.0", "revision": DOI},
        {"name": "mendeley-fake-audio/metadata.xlsx", "url": SOURCE_URL,
         "path": str(WORKBOOK.relative_to(WORK)).replace("\\", "/"), "bytes": WORKBOOK.stat().st_size,
         "sha256": EXPECTED[WORKBOOK], "license": "CC BY 4.0", "revision": DOI},
    ])
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

if __name__ == "__main__":
    extract_verified()
    records = validate_records(workbook_rows())
    (DATASET / "records.json").write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
    selected = install_showcase(records)
    update_source_manifest()
    counts = {f"{tool}-{kind}": sum(r["tool"] == tool and r["generationType"] == kind for r in records)
              for tool in ("ElevenLabs", "Respeecher") for kind in ("TTS", "V2V")}
    print(json.dumps({"installed": len(records), "callDeskSamples": len(selected), "counts": counts,
                      "actualSampleRates": {str(rate): sum(r["sampleRate"] == rate for r in records) for rate in sorted({r["sampleRate"] for r in records})},
                      "publisherSampleRateMismatches": sum(not r["sampleRateMatchesPublisher"] for r in records),
                      "publisherDurationMismatches": sum(not r["durationMatchesPublisher"] for r in records)}, indent=2))
