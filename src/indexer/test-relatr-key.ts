/**
 * Test script that uses the SAME approach as nostube web app:
 * explicit private key passed to PrivateKeySigner
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrClientTransport, PrivateKeySigner, ApplesauceRelayPool } from '@contextvm/sdk';
import { generateSecretKey } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';
import { nip19 } from 'nostr-tools';

const SERVER_NPUB = 'npub16w48u4xvtlp7ywgfsjlud74tlgdfx9s33scdlafmgl3a40n9tthsu6ty8g';
const CONTEXTVM_RELAYS = ['wss://relay.contextvm.org', 'wss://relay2.contextvm.org']; // relay2 added for redundancy
const decoded = nip19.decode(SERVER_NPUB);
const SERVER_PUBKEY_HEX = decoded.data as string;

async function main() {
  // Use the SAME approach as nostube: explicit ephemeral key
  const ephemeralKey = bytesToHex(generateSecretKey());
  console.log('Ephemeral pubkey:', nip19.npubEncode(getPublicKeyFromHex(ephemeralKey)));
  
  const signer = new PrivateKeySigner(ephemeralKey);
  const relayPool = new ApplesauceRelayPool(CONTEXTVM_RELAYS);

  const transport = new NostrClientTransport({
    serverPubkey: SERVER_PUBKEY_HEX,
    signer,
    relayHandler: relayPool,
    isStateless: true,
  });

  const client = new Client({
    name: 'nostube-search-test',
    version: '1.0.0',
  });

  try {
    await client.connect(transport);
    console.log('Client connected');

    console.log('Calling calculate_trust_scores...');
    const result = await client.callTool({
      name: 'calculate_trust_scores',
      arguments: { targetPubkeys: [SERVER_PUBKEY_HEX] },
    });
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

function getPublicKeyFromHex(hex: string): string {
  const { getPublicKey } = require('nostr-tools');
  return getPublicKey(new Uint8Array(hex.match(/.{1,2}/g)!.map(b => parseInt(b, 16))));
}

main();