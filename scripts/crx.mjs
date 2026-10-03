import { createHash, createPublicKey, verify } from 'node:crypto';

function fields(bytes) {
  let offset = 0;
  const result = [];
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error('Truncated CRX protobuf.');
      const byte = bytes[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Oversized CRX protobuf value.');
        return Number(value);
      }
    }
    throw new Error('Invalid CRX protobuf varint.');
  };
  while (offset < bytes.length) {
    const tag = varint(), number = Math.floor(tag / 8), type = tag & 7;
    if (!number) throw new Error('Invalid CRX protobuf field.');
    if (type === 0) result.push({ number, value: varint() });
    else if (type === 2) {
      const length = varint();
      if (length > bytes.length - offset) throw new Error('Truncated CRX protobuf field.');
      result.push({ number, value: bytes.subarray(offset, offset + length) });
      offset += length;
    } else if (type === 1 || type === 5) {
      const length = type === 1 ? 8 : 4;
      if (length > bytes.length - offset) throw new Error('Truncated CRX protobuf field.');
      offset += length;
    } else throw new Error('Unsupported CRX protobuf wire type.');
  }
  return result;
}

function onlyBytes(list, number, label) {
  const matches = list.filter((field) => field.number === number);
  if (matches.length !== 1 || !Buffer.isBuffer(matches[0].value)) throw new Error(`Invalid CRX ${label}.`);
  return matches[0].value;
}

export function extensionId(bytes) {
  return bytes.toString('hex').replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
}

// CRX3 contains public keys only. This verifier never opens a private key.
export function verifyCrx(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'Cr24') throw new Error('Invalid CRX magic.');
  if (bytes.readUInt32LE(4) !== 3) throw new Error('Only CRX3 packages are supported.');
  const headerLength = bytes.readUInt32LE(8);
  if (!headerLength || headerLength > 1_000_000 || headerLength > bytes.length - 12) throw new Error('Invalid CRX3 header length.');
  const header = fields(bytes.subarray(12, 12 + headerLength));
  const signedHeader = onlyBytes(header, 10000, 'signed header');
  const id = onlyBytes(fields(signedHeader), 1, 'extension identity');
  if (id.length !== 16) throw new Error('Invalid CRX extension identity length.');
  const archive = bytes.subarray(12 + headerLength);
  if (archive.length < 22 || archive.subarray(0, 4).toString('hex') !== '504b0304') throw new Error('CRX contains no ZIP payload.');
  const signedLength = Buffer.alloc(4);
  signedLength.writeUInt32LE(signedHeader.length);
  const signed = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'ascii'), signedLength, signedHeader, archive]);
  let verifiedProof;
  const proofs = header.filter((field) => field.number === 2);
  if (!proofs.length) throw new Error('CRX3 has no RSA proof.');
  for (const field of proofs) {
    if (!Buffer.isBuffer(field.value)) throw new Error('Invalid CRX RSA proof.');
    const proof = fields(field.value);
    const publicKey = onlyBytes(proof, 1, 'RSA public key');
    const signature = onlyBytes(proof, 2, 'RSA signature');
    const publicKeyHash = createHash('sha256').update(publicKey).digest();
    if (!publicKeyHash.subarray(0, 16).equals(id)) continue;
    const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa' || !verify('sha256', signed, key, signature)) throw new Error('CRX3 RSA signature verification failed.');
    verifiedProof = publicKeyHash.toString('hex');
  }
  if (!verifiedProof) throw new Error('CRX3 has no verified RSA proof for its extension identity.');
  return { archive, extensionId: extensionId(id), publicKeySha256: verifiedProof, signature: 'verified RSA/SHA-256' };
}
