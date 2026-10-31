#!/bin/sh
# Generates the self-signed code-signing identity the fork signs its macOS app with, then prints
# the commands that store it as the CSC_LINK and CSC_KEY_PASSWORD secrets of the fork-release workflow.
#
#   scripts/generate-macos-self-signed-identity.sh <output-dir> [common-name]
#
# Generate it once and keep <output-dir> safe. Installed apps accept an update only when it is signed
# by this same certificate, so a new identity means every Mac reinstalls by hand.
set -eu

[ "$#" -ge 1 ] || { echo "usage: $0 <output-dir> [common-name]" >&2; exit 2; }
out="$1"
name="${2:-T3 Code jj fork}"
repo="${T3CODE_FORK_REPOSITORY:-kaedendev/t3code}"

command -v openssl >/dev/null 2>&1 || { echo "openssl is required." >&2; exit 1; }
[ ! -e "$out" ] || { echo "$out already exists; refusing to replace an identity." >&2; exit 1; }
mkdir -p "$out"
chmod 700 "$out"
umask 077

openssl rand -base64 24 | tr -d '\n' > "$out/csc_key_password"
openssl req -x509 -newkey rsa:3072 -sha256 -days 7300 -nodes \
  -subj "/CN=$name" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -keyout "$out/key.pem" -out "$out/cert.pem" 2>/dev/null
# macOS `security import` reads 3DES/SHA-1 PKCS#12 files, not OpenSSL 3's AES default.
openssl pkcs12 -export -name "$name" -inkey "$out/key.pem" -in "$out/cert.pem" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout "file:$out/csc_key_password" -out "$out/identity.p12"
base64 < "$out/identity.p12" | tr -d '\n' > "$out/csc_link"
rm -f "$out/key.pem"

echo "Identity: $(openssl x509 -in "$out/cert.pem" -noout -subject -fingerprint -sha1)"
echo
echo "Store it on $repo:"
echo "  gh secret set CSC_LINK --repo $repo < '$out/csc_link'"
echo "  gh secret set CSC_KEY_PASSWORD --repo $repo < '$out/csc_key_password'"
