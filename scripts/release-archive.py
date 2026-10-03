#!/usr/bin/env python3
"""Deterministic release ZIP creation and exact source/payload verification."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import zipfile


def archive_bytes(path):
    data = path.read_bytes()
    if data[:4] == b'Cr24':
        if len(data) < 12:
            raise ValueError('Truncated CRX header')
        version, header_size = struct.unpack('<II', data[4:12])
        if version != 3 or header_size > len(data) - 12:
            raise ValueError('Invalid CRX3 header')
        data = data[12 + header_size:]
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['create', 'verify'])
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--files', required=True, help='JSON array of allowlisted runtime paths')
    parser.add_argument('--allow-icons-directory', action='store_true')
    args = parser.parse_args()
    names = json.loads(args.files)
    if not isinstance(names, list) or len(set(names)) != len(names):
        raise ValueError('Invalid runtime allowlist')
    if args.operation == 'create':
        with zipfile.ZipFile(args.archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name in names:
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, (args.source / name).read_bytes(), compresslevel=9)
    with zipfile.ZipFile(io.BytesIO(archive_bytes(args.archive))) as archive:
        entries = archive.infolist()
        actual = [entry.filename for entry in entries]
        if len(set(actual)) != len(actual):
            raise ValueError('Archive contains duplicate paths')
        directories = [entry.filename for entry in entries if entry.is_dir()]
        if directories and (not args.allow_icons_directory or directories != ['icons/']):
            raise ValueError('Archive contains unexpected directories')
        if set(actual) - set(directories) != set(names):
            raise ValueError('Archive does not contain the exact runtime allowlist')
        hashes = []
        for name in names:
            entry = archive.getinfo(name)
            if entry.flag_bits & 1:
                raise ValueError('Archive payload is encrypted')
            file_type = (entry.external_attr >> 16) & 0o170000
            if file_type not in (0, 0o100000):
                raise ValueError('Archive runtime entry is not a regular file')
            if entry.file_size > 20_000_000:
                raise ValueError('Unexpected runtime entry size')
            expected = (args.source / name).read_bytes()
            payload = archive.read(name)
            if payload != expected:
                raise ValueError('Archive runtime differs from source: ' + name)
            hashes.append({'path': name, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()})
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('version') != '1.1.0' or manifest.get('manifest_version') != 3:
            raise ValueError('Expected Manifest V3 and unpublished version 1.1.0')
    print(json.dumps({'runtimeFiles': len(hashes), 'files': hashes, 'version': manifest['version']}))


if __name__ == '__main__':
    main()
