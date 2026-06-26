declare module "gltf-validator" {
  export interface ValidatorMessage {
    code: string;
    message: string;
    /** 0 = error, 1 = warning, 2 = info, 3 = hint. */
    severity: number;
    pointer?: string;
  }
  export interface ValidatorReport {
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      numHints: number;
      messages: ValidatorMessage[];
    };
  }
  export function validateBytes(
    data: Uint8Array,
    options?: unknown
  ): Promise<ValidatorReport>;
}
