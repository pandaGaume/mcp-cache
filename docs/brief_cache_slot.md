# Cache comme slot générique

Date : 2 octobre 2026
Base : `@cyanmycelium/mcp-broker` 1.6.0, `@cyanmycelium/mcp-broker-provider` 0.3.0, `@cyanmycelium/mcp-core` 1.4.0, `@cyanmycelium/mcp-uns` 0.1.0
Origine : [historisation comme slot générique](../../mcp-history/docs/brief_history_slot.md), dont ce dépôt reprend la forme

## Décisions prises

| Sujet | Décision |
|---|---|
| Dépôt | `mcp-cache`, séparé de `mcp-history` |
| Adressage | par **id UNS** : la policy qui gouverne une valeur SCADA gouverne aussi sa copie en cache |
| Paquets | `@cyanmycelium/mcp-cache` (contrat, store mémoire, slot, conformité en `/conformance`) et `@cyanmycelium/mcp-cache-redis` |
| Valeurs | toute valeur JSON, `null` compris, plafonnée en octets |

## Contrat `cache.v1`

Comme pour l'historique, il existe deux formes qui disent la même chose : l'interface `ICacheStore` et les outils `cache.*` produits par `CacheBehavior`. `CacheSlotStore` fait le chemin inverse, et la suite de conformité tourne sur les deux.

| Opération | Entrée | Sortie |
|---|---|---|
| `getCapabilities` | | shared, durability, defaultTtlMs, evicts, limits |
| `get` | ids | un item par id, dans l'ordre : `hit` (value, storedAt, expiresAt), `miss`, ou erreur |
| `set` | `{ id, value, ttlMs? }[]` | `{ stored, rejected[{ index, error }] }` |
| `delete` | ids | `{ deleted, errors }` |
| `scan` | racine UNS, limit, cursor | ids vivants, cursor |

Règles communes, fixées par la suite de conformité :

- **`set` remplace** la valeur et l'expiration. Sans `ttlMs`, c'est `defaultTtlMs` qui s'applique, ou pas d'expiration s'il est `null`. Un store qui fixe `maxTtlMs` doit aussi fixer un `defaultTtlMs` inférieur ou égal : toute entrée expire alors.
- **Un `miss` ne dit jamais pourquoi** : jamais posé, supprimé, expiré ou évincé, c'est pareil.
- **Une entrée invalide est rejetée seule**, avec son index : id non canonique, valeur absente ou non JSON, `ttlMs` invalide ou trop long, valeur trop grosse. Un même id deux fois dans un `set` refuse la requête entière, car laisser chaque store choisir lequel gagne n'est pas acceptable.
- **`scan`** respecte les frontières de segment. Il ne promet **ni ordre ni unicité** et peut rendre une page courte avant la dernière, comme le `SCAN` de Redis : le contrat ne promet rien de plus que le backend le plus faible.
- **Expiration** testée en temps réel, avec un TTL court, pour qu'un store dont l'horloge est celle d'un serveur soit testé comme un store en mémoire.
- **Isolation** : un appelant ne partage jamais d'objet avec le cache.

## Backends

| | `MemoryCacheStore` | `RedisCacheStore` |
|---|---|---|
| Partagé entre processus | non | oui |
| Expiration | à la lecture, sur l'horloge du processus | par le serveur (`SET ... PX`) |
| Éviction | LRU si `maxEntries` | selon `maxmemory-policy` (`evicts: true` par défaut) |
| Stockage | JSON encodé en mémoire | une clé `<prefix><id UNS>` par entrée, enveloppe `{ s, e, v }` |
| `scan` | trié, curseur sur le dernier id | `SCAN MATCH`, filtré aux segments entiers, ids encore vivants vérifiés par `MGET` |

Le store Redis passe par une petite interface (`IRedisCommands`). Cela permet de tester sa logique sur un faux Redis qui se comporte aussi mal que `SCAN` en a le droit : pages plus longues que `COUNT`, doublons, clés expirées encore visibles. La même suite tourne contre un vrai serveur dès que `REDIS_URL` est défini, avec les réglages Redis standard : `REDIS_URL` avec son schéma (`rediss://` pour le TLS), `REDIS_PASSWORD` et `REDIS_USERNAME` facultatifs.

## Autorisation (broker)

| Outil | Capability | Résultat rapporté |
|---|---|---|
| `cache.capabilities` | aucune | non |
| `cache.get`, `cache.scan` | `cache.read`, par id ; `scan` filtre les ids refusés | non |
| `cache.set`, `cache.delete` | `cache.write`, par id | oui |

Déclaration (`buildCacheDeclaration`) : domaine `cache`, namespace égal à la racine UNS servie, `resultsRequired: ["cache.write"]`. Elle ne contient aucune attribution de droit.

## Usage attendu dans mcp-scada

La destination `local` de mcp-scada reste servie **dans le processus**, car passer par un slot ajouterait un saut réseau à une lecture qui promet de n'en faire aucun. `LocalValueCache` peut s'appuyer sur `ICacheStore` : la mémoire par défaut, ou Redis quand plusieurs instances de mcp-scada doivent partager la même vue `local`. Le slot `cache` sert les autres consommateurs : pages web, agents, recorder.

## État

- **Fait** : contrat, `MemoryCacheStore`, `RedisCacheStore`, `CacheBehavior`, `CacheSlotStore`, déclaration, suite de conformité. 112 tests, dont 4 contre un vrai broker, 23 sur le faux Redis et 20 contre un Azure Cache for Redis réel (TLS, port 6380). Chaque test y écrit sous son propre préfixe et supprime ses clés.
- **Fait dans mcp-scada** : `LocalValueCache` repose sur `ICacheStore` (options `localCache` et `localCacheTtlMs` du service). Un cache illisible donne `cache_miss` avec `reason: "cache_unavailable"`, ce qui laisse un repli explicite aller jusqu'à la source.
