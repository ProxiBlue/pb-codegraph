// Injects augmenter-owned minted nodes/edges into an isolated fixture db
// copy for MCP find_symbol/context/impact tests. Uses the real writer
// (augmenter/src/writer/sqlite-writer.ts) so the shape written (remapped
// lowercase kind, provenance, JSON metadata) matches production exactly
// rather than hand-rolled INSERTs drifting from the writer's own rules.
import { openWriterDb, writeAugmentation, type AugmentInput, type WriteResult } from '../../augmenter/src/writer/sqlite-writer.ts';

export function injectMagentoEdges(dbPath: string, input: AugmentInput): WriteResult {
  const db = openWriterDb(dbPath);
  try {
    return writeAugmentation(db, input);
  } finally {
    db.close();
  }
}
