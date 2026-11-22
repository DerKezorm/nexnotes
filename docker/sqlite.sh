#!/bin/sh
# SQLite's library from the official source, for the image (Dockerfile) and for CI alike, so that the tests run the
# SQLite the server runs. The library of Debian (3.46 in trixie) and Ubuntu is far behind: with it a search for a long
# phrase in the trigram index takes minutes instead of a fraction of a second (NOTES-9 EC-5), and other searches miss
# their limits too.
#
#   docker/sqlite.sh <folder>    builds <folder>/libsqlite3.so.0 with $CC (default: cc)
#
# The download is checked against the SHA3-256 that sqlite.org gives on its download page. A new version: change
# VERSION, FILE, YEAR and SHA3_256 together.
set -eu

VERSION=3.54.1
FILE=sqlite-autoconf-3540100.tar.gz
YEAR=2026
SHA3_256=b6ced585c750916b1052667239a12c25a7ff34e7f06e1e6e01ecb0427657d9c4

out=${1:?usage: sqlite.sh <folder>}
cc=${CC:-cc}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

python3 - "https://sqlite.org/$YEAR/$FILE" "$work/$FILE" "$SHA3_256" <<'EOF'
import hashlib
import sys
import urllib.request

url, path, wanted = sys.argv[1:]
with urllib.request.urlopen(url, timeout=120) as answer:
    data = answer.read()
found = hashlib.sha3_256(data).hexdigest()
if found != wanted:
    sys.exit(f"{url}: SHA3-256 is {found}, expected {wanted}")
with open(path, "wb") as file:
    file.write(data)
EOF

tar -xzf "$work/$FILE" -C "$work"
mkdir -p "$out"
# The options of Debian's own library (PRAGMA compile_options), so that nothing Python's sqlite3 module, the app or
# another program of the image expects goes missing; secure_delete stays on by default as there.
"$cc" -O2 -fPIC -shared -s -Wl,-soname,libsqlite3.so.0 \
    -DSQLITE_THREADSAFE=1 -DSQLITE_USE_URI=1 -DSQLITE_SECURE_DELETE -DSQLITE_SOUNDEX \
    -DSQLITE_LIKE_DOESNT_MATCH_BLOBS -DSQLITE_MAX_SCHEMA_RETRY=25 -DSQLITE_MAX_VARIABLE_NUMBER=250000 \
    -DSQLITE_ENABLE_FTS3 -DSQLITE_ENABLE_FTS3_PARENTHESIS -DSQLITE_ENABLE_FTS3_TOKENIZER -DSQLITE_ENABLE_FTS4 \
    -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_ENABLE_COLUMN_METADATA \
    -DSQLITE_ENABLE_DBPAGE_VTAB -DSQLITE_ENABLE_DBSTAT_VTAB -DSQLITE_ENABLE_STMTVTAB -DSQLITE_ENABLE_UNLOCK_NOTIFY \
    -DSQLITE_ENABLE_PREUPDATE_HOOK -DSQLITE_ENABLE_SESSION \
    "$work/${FILE%.tar.gz}/sqlite3.c" -o "$out/libsqlite3.so.0" -lm -lpthread -ldl
echo "SQLite $VERSION built: $out/libsqlite3.so.0"
