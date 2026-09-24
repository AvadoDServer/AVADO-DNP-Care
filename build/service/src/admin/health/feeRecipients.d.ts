export interface ClientFeeRecipients {
  validators: number;
  checked: number;
  missing: number;
}
export declare const VALIDATOR_CLIENTS: ReadonlyArray<{ name: string; keymanager: string }>;
export declare const MAX_KEYS_CHECKED: number;
export declare function readClientFeeRecipients(client: { name: string; keymanager: string }, fetchImpl?: typeof fetch): Promise<ClientFeeRecipients | null>;
export declare function fetchFeeRecipients(
  packages: ReadonlyArray<{ name: string; running?: boolean }>,
  fetchImpl?: typeof fetch,
): Promise<Record<string, ClientFeeRecipients> | null>;
