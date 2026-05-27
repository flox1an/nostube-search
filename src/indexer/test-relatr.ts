import { connectTrustScoreClient } from './relatr.js';
import { nip19 } from 'nostr-tools';

const SERVER_NPUB = 'npub16w48u4xvtlp7ywgfsjlud74tlgdfx9s33scdlafmgl3a40n9tthsu6ty8g';
const decoded = nip19.decode(SERVER_NPUB);
const SERVER_PUBKEY_HEX = decoded.data as string;

async function main() {
  console.log('Server pubkey hex:', SERVER_PUBKEY_HEX);
  try {
    const client = await connectTrustScoreClient();
    console.log('Client connected');

    // Try calling the tool
    console.log('Calling calculate_trust_scores with 1 pubkey...');
    const result = await client.callTool({
      name: 'calculate_trust_scores',
      arguments: { targetPubkeys: [SERVER_PUBKEY_HEX] },
    });
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}
main();