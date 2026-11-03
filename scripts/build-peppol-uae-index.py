#!/usr/bin/env python3
"""Stream the official Directory XML export into UAE or global JSONL records."""

import argparse
import gzip
import json
import os
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = "{urn:peppol:schema:pd:businesscard-generic:2025:03}"


def child_text(element, name):
    child = element.find(NS + name)
    return child.text if child is not None else None


def card_record(card, country_code="AE"):
    participant = card.find(NS + "participant")
    if participant is None:
        return None
    entities = []
    for entity in card.findall(NS + "entity"):
        entity_country = entity.get("countrycode")
        if country_code and entity_country != country_code:
            continue
        names = [{"name": item.get("name"), **({"language": item.get("language")} if item.get("language") else {})}
                 for item in entity.findall(NS + "name") if item.get("name")]
        if not names:
            continue
        result = {"names": names, "country_code": entity_country}
        for xml_name, output_name in (("geoinfo", "geo_info"), ("additionalinfo", "additional_info"),
                                      ("regdate", "registration_date")):
            value = child_text(entity, xml_name)
            if value:
                result[output_name] = value
        for xml_name, output_name in (("id", "identifiers"), ("website", "websites"), ("contact", "contacts")):
            items = entity.findall(NS + xml_name)
            if items:
                result[output_name] = ([item.text for item in items if item.text] if xml_name == "website"
                                       else [dict(item.attrib) for item in items])
        entities.append(result)
    if not entities:
        return None
    doc_types = []
    for item in card.findall(NS + "doctypeid"):
        if not item.get("value"):
            continue
        record = {"scheme": item.get("scheme"), "value": item.get("value")}
        for xml_name, output_name in (("displayname", "display_name"), ("state", "state"),
                                      ("non-standard", "non_standard")):
            if item.get(xml_name) is not None:
                record[output_name] = item.get(xml_name)
        doc_types.append(record)
    return {"participant_id": dict(participant.attrib), "document_types": doc_types, "entities": entities}


def convert(source, output, country_code, skip_cards=0):
    count = 0
    with (gzip.open(source, "rb") if source.suffix == ".gz" else open(source, "rb")) as source_file:
        context = ET.iterparse(source_file, events=("start", "end"))
        _, root = next(context)
        if root.tag != NS + "root" or root.get("version") != "3" or not root.get("creationdt"):
            raise ValueError("Unsupported Peppol Directory XML export")
        metadata = {"schema_version": 1, "source": "peppol_directory_export", "country": country_code,
                    "snapshot_at": root.get("creationdt"), "code_list_version": root.get("codeListSupported")}
        output.write(json.dumps({"_meta": metadata}, ensure_ascii=False, separators=(",", ":")) + "\n")
        for event, element in context:
            if event != "end" or element.tag != NS + "businesscard":
                continue
            record = card_record(element, country_code)
            if record:
                count += 1
                if count > skip_cards:
                    output.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            root.clear()
        output.write(json.dumps({"_footer": {"cards": count}}, separators=(",", ":")) + "\n")
    return metadata, count


def build(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            metadata, count = convert(source, output, "AE")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    except Exception:
        os.unlink(temporary)
        raise
    return metadata, count


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Full export-all-businesscards.xml")
    parser.add_argument("target", type=Path, nargs="?", help="Output UAE index JSONL")
    parser.add_argument("--stream-all", action="store_true", help="Stream all countries as JSONL to stdout")
    parser.add_argument("--skip-cards", type=int, default=0, help="Skip this many business cards when streaming")
    args = parser.parse_args()
    if args.stream_all:
        if args.target:
            parser.error("target is not used with --stream-all")
        if args.skip_cards < 0:
            parser.error("--skip-cards must be non-negative")
        convert(args.source, sys.stdout, None, args.skip_cards)
    else:
        if not args.target:
            parser.error("target is required for UAE index output")
        meta, cards = build(args.source, args.target)
        print(json.dumps({"snapshot_at": meta["snapshot_at"], "country": "AE", "cards": cards,
                          "index_bytes": args.target.stat().st_size}))
