import type { IOrdOutput } from '../types/index.js';

/**
 * HTTP client for the local ord node REST API.
 *
 * Requires ord to be running with `--http` flag.
 * Default: http://localhost:80
 *
 * @example
 * ```typescript
 * const client = new OrdClient('http://localhost:80');
 * const output = await client.getOutput('abc123', 0);
 * ```
 */
export class OrdClient {
    private readonly baseUrl: string;

    public constructor(baseUrl: string) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    /**
     * Fetches inscription data for a given UTXO.
     * Returns which inscriptions are (or were) sitting on this output.
     *
     * @param txid - The transaction ID
     * @param vout - The output index
     * @returns Ord output data including inscription IDs, or null on 404
     * @throws On network errors or unexpected status codes
     */
    public async getOutput(txid: string, vout: number): Promise<IOrdOutput | null> {
        const url = `${this.baseUrl}/output/${txid}:${vout.toString()}`;

        const response = await fetch(url, {
            headers: { Accept: 'application/json' },
        });

        if (response.status === 404) {
            return null;
        }

        if (!response.ok) {
            throw new Error(
                `Ord /output/${txid}:${vout.toString()} returned ${response.status.toString()}`,
            );
        }

        return (await response.json()) as IOrdOutput;
    }

    /**
     * Fetches inscription content from the local ord node.
     *
     * @param inscriptionId - The inscription ID (e.g. "abc123...i0")
     * @returns Content bytes and Content-Type, or null on 404
     */
    public async getInscriptionContent(
        inscriptionId: string,
    ): Promise<{ readonly data: ArrayBuffer; readonly contentType: string } | null> {
        const url = `${this.baseUrl}/inscription/${inscriptionId}/content`;

        const response = await fetch(url);

        if (response.status === 404) {
            return null;
        }

        if (!response.ok) {
            throw new Error(
                `Ord /inscription/${inscriptionId}/content returned ${response.status.toString()}`,
            );
        }

        const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
        const data = await response.arrayBuffer();

        return { data, contentType };
    }
}
