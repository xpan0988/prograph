import type {SemanticStore} from '../../src/core/semantic/store.js';
import {MIGRATION_PIN} from '../../src/core/semantic/authority-migration.js';
/** Explicit test maintenance, after positively checking the migration's pin ownership. */
export function releaseMigrationRetention(store:SemanticStore){
  const pins=store.sql('SELECT snapshot FROM sc_snapshot_pins WHERE label=?').all(MIGRATION_PIN) as Array<{snapshot:number}>;
  for(const pin of pins)store.unpinSnapshot(pin.snapshot,MIGRATION_PIN);
  return pins.length;
}
