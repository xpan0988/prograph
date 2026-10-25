// Stage 6.6 diagnostic prototype ONLY. Not imported by production source.
import { types } from 'node:util';

export function provenanceReuseCandidate({ canonical, semanticKey, digest }) {
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
  const iteratorPrototype = prototype([][iterator]());
  guards.push({ object: iteratorPrototype, key: 'next', value: descriptor(iteratorPrototype, 'next')?.value });
  const iteratorChain = [];
  for (let item = iteratorPrototype; item; item = prototype(item)) iteratorChain.push({ item, parent: prototype(item) });
  function reusable(fact) {
    // Descriptor reads avoid adding observable getters while deciding to fall back.
    for (let i = 0; i < guards.length; i++) {
      const guard = guards[i]; if (descriptor(guard.object, guard.key)?.value !== guard.value) return false;
    }
    if (descriptor(array, species)?.get !== speciesGetter) return false;
    for (let i = 0; i < iteratorChain.length; i++) {
      const link = iteratorChain[i]; if (prototype(link.item) !== link.parent || descriptor(link.item, 'return')) return false;
    }
    if (!fact || typeof fact !== 'object' || types.isProxy(fact)) return false;
    const property = descriptor(fact, 'provenance');
    if (!property || !owns(property, 'value')) return false;
    const value = property.value;
    if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
    const parent = prototype(value); if (parent !== objectPrototype && parent !== null) return false;
    const names = keys(value);
    for (let i = 0; i < names.length; i++) {
      const member = descriptor(value, names[i]);
      if (!member || !owns(member, 'value') || typeof member.value !== 'string') return false;
    }
    return true;
  }
  return fact => {
    const reuse = reusable(fact);
    const encoded = canonical(fact.provenance);
    return { encoded, key: reuse ? `sc2:provenance:${digest(encoded)}` : semanticKey('provenance', fact.provenance), reused: reuse };
  };
}
