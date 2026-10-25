/** Reuse only the adjacent provenance persistence/key encoding. No data survives
 * this synchronous operation. Observable inputs retain both reference encodings. */
import { types } from "node:util";
import * as model from "./model.js";
import type { FactInput } from "./model.js";

export interface ProvenanceEncoding { readonly encoded: string; readonly key: string; readonly reused: boolean }

function createProvenanceEncoder({ canonical, semanticKey, digest }: Pick<typeof model, "canonical" | "semanticKey" | "digest">) {
  const descriptor = Object.getOwnPropertyDescriptor, keys = Object.keys, prototype = Object.getPrototypeOf, owns = Object.hasOwn;
  const object = Object, objectPrototype = Object.prototype, array = Array, arrayPrototype = Array.prototype, json = JSON;
  const iterator = Symbol.iterator, species = Symbol.species;
  const guards = [
    { object: globalThis, key: 'Object', value: object }, { object: globalThis, key: 'Array', value: array }, { object: globalThis, key: 'JSON', value: json },
    { object, key: 'entries', value: Object.entries }, { object: json, key: 'stringify', value: JSON.stringify },
    { object: array, key: 'isArray', value: Array.isArray },
    ...['map', 'sort', 'join', 'constructor'].map(key => ({ object: arrayPrototype, key, value: descriptor(arrayPrototype, key)?.value })),
    { object: arrayPrototype, key: iterator, value: descriptor(arrayPrototype, iterator)?.value },
  ];
  const speciesGetter = descriptor(array, species)?.get;
  const iteratorPrototype = prototype(([] as unknown as Record<symbol, () => Iterator<unknown>>)[iterator]!());
  guards.push({ object: iteratorPrototype, key: 'next', value: descriptor(iteratorPrototype, 'next')?.value });
  const iteratorChain: Array<{ item: object; parent: object | null }> = [];
  for (let item = iteratorPrototype; item; item = prototype(item)) iteratorChain.push({ item, parent: prototype(item) });
  function reusable(fact: FactInput): boolean {
    // Descriptor reads avoid adding observable getters while deciding to fall back.
    for (let i = 0; i < guards.length; i++) {
      const guard = guards[i]!, property = descriptor(guard.object, guard.key);
      if (!property || !owns(property, 'value') || property.value !== guard.value) return false;
    }
    const speciesProperty = descriptor(array, species);
    if (!speciesProperty || !owns(speciesProperty, 'get') || speciesProperty.get !== speciesGetter) return false;
    for (let i = 0; i < iteratorChain.length; i++) {
      const link = iteratorChain[i]!; if (prototype(link.item) !== link.parent || descriptor(link.item, 'return')) return false;
    }
    if (!fact || typeof fact !== 'object' || types.isProxy(fact)) return false;
    const property = descriptor(fact, 'provenance');
    if (!property || !owns(property, 'value')) return false;
    const value = property.value;
    if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
    const parent = prototype(value); if (parent !== objectPrototype && parent !== null) return false;
    const names = keys(value);
    for (let i = 0; i < names.length; i++) {
      const member = descriptor(value, names[i]!);
      if (!member || !owns(member, 'value') || typeof member.value !== 'string') return false;
    }
    return true;
  }
  return (fact: FactInput): ProvenanceEncoding => {
    const reuse = reusable(fact);
    const encoded = canonical(fact.provenance);
    return { encoded, key: reuse ? `sc2:provenance:${digest(encoded)}` : semanticKey('provenance', fact.provenance), reused: reuse };
  };
}

export const encodeFactProvenance = createProvenanceEncoder(model);
