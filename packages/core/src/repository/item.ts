// ---- item shape -------------------------------------------------------------

/** The raw single-table record. Every entity is stored as one of these. */
export interface Item {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI2SK?: string;
  GSI3PK?: string;
  GSI3SK?: string;
  entityType: string;
  [k: string]: unknown;
}

/** Secondary indexes; `undefined` queries the base table's PK/SK. */
export type IndexName = "GSI1" | "GSI2" | "GSI3";
