# nestjs-paginate-micro

A separately cloned adaptation of [nestjs-paginate](https://github.com/ppetzold/nestjs-paginate) for MikroORM. It retains the familiar NestJS `@Paginate()` query decorator, `paginate(query, repositoryOrBuilder, config)` call, `PaginateConfig`, `Paginated<T>` response shape, filter URL syntax, and Swagger decorators. This repository is not a GitHub fork. The upstream MIT license is retained.

## Scope and compatibility

The package targets MikroORM 7.2 and retains tested runtime support for MikroORM 6.6. It provides both CommonJS (`require`) and ESM (`import`) entry points; the same source adapts to each version's cursor API at runtime. NestJS 11 and 12 are declared peers, with NestJS 12 used by the test suite. Node 24+ is required. MikroORM 6's separate `@mikro-orm/nestjs` integration package does **not** declare NestJS 12 support; check its compatibility before migrating a NestJS 12 application. ORM 7 integration into Nest may also require choosing an integration package/version appropriate to the application.

Install from the local clone:

```sh
pnpm add /absolute/path/to/nestjs-paginate-micro
```

The consuming application also needs `@mikro-orm/core` 6.6 or 7.x and a matching MikroORM driver such as `@mikro-orm/postgresql`. Keep all MikroORM packages on the same major. This package does not install or configure MikroORM for you.

## Minimal pagination migration

After migrating the entity and repository registration from TypeORM to MikroORM, change the pagination import. The controller and URL parameters can remain as they are:

```diff
- import { InjectRepository } from '@nestjs/typeorm'
- import { Repository } from 'typeorm'
- import { Paginate, paginate } from 'nestjs-paginate'
+ import { InjectRepository } from '@mikro-orm/nestjs'
+ import { EntityRepository } from '@mikro-orm/postgresql'
+ import { Paginate, paginate } from 'nestjs-paginate-micro'
```

That import diff applies when using a compatible `@mikro-orm/nestjs` version; see the compatibility note above.

```ts
import { Paginate, PaginateQuery, PaginatedSwaggerDocs } from 'nestjs-paginate-micro'

@Get()
@PaginatedSwaggerDocs(AdminDoctorDto, DoctorsService.ADMIN_PAGINATE_CONFIG)
findAll(@Paginate() query: PaginateQuery) {
  return this.doctorsService.findAllForAdmin(query)
}
```

For a repository based service, the pagination call and ordinary config are the same:

```ts
import { EntityRepository } from '@mikro-orm/postgresql'
import { PaginateConfig, PaginateQuery, paginate } from 'nestjs-paginate-micro'

const ADMIN_PAGINATE_CONFIG: PaginateConfig<DoctorProfile> = {
  sortableColumns: ['createdAt', 'lastName', 'verificationStatus'],
  searchableColumns: ['firstName', 'lastName', 'bio'],
  filterableColumns: { verificationStatus: true },
  defaultSortBy: [['createdAt', 'DESC']],
  relations: {
    specializations: true,
    languages: true,
    practiceCountries: true,
    licenses: { country: true },
  },
}

function findAllForAdmin(
  query: PaginateQuery,
  doctors: EntityRepository<DoctorProfile>,
) {
  return paginate(query, doctors, ADMIN_PAGINATE_CONFIG)
}
```

This replaces a TypeORM `createQueryBuilder(...).setFindOptions({ relations, relationLoadStrategy: 'query' })` list. The adapter uses MikroORM `select-in` loading for `relations` by default. It keeps pagination on root entities and returns `{ data, meta, links }`. A MikroORM query builder can be passed to `paginate` when it already has a base scope; configure its relation loading on the builder itself.

Existing requests such as `?page=2&limit=20&search=Alice&filter.verificationStatus=pending` continue to work. Supported query parameters: `page`, `limit`, repeated `sortBy`, `search`, `searchBy`, `filter.<column>`, boolean `filter=` expressions, `select`, and `cursor`. Only config allow-listed columns are used. Unknown filters are ignored by default; `throwOnInvalidFilter: true` returns HTTP 400.

## Feature coverage

| Feature | Status |
| --- | --- |
| Offset pages, count, `meta`, `links` | Supported with repository or MikroORM query builder |
| Search | Case insensitive: PostgreSQL `ILIKE`; SQLite test fallback `LIKE` |
| Sorting | Multiple allow-listed scalar or dotted property paths |
| Filters | `$eq`, `$not`, `$null`, `$in`, comparisons, `$btw`, `$ilike`, `$sw`, `$contains`; repeated filters and boolean expressions |
| Filter value types | Inferred from MikroORM metadata for repositories; `filterValueTypes` overrides or supplies types for builders |
| Relations | `relations` with repository and `select-in` loading; nested paths accepted |
| Cursor | MikroORM native cursor pages with next and previous links, repository only |
| Swagger | `ApiPaginationQuery`, `ApiOkPaginatedResponse`, `PaginatedSwaggerDocs` retained |

## Differences from TypeORM nestjs-paginate

- Cursor tokens are MikroORM tokens. Existing TypeORM cursor bookmarks cannot be reused. Cursor mode returns no `totalItems`, matching upstream's cursor response shape. Use a unique tie-breaker such as `id` in `defaultSortBy`.
- TypeORM `joinMethods`, `defaultJoinMethod`, polymorphic `~` sorting, relation quantifiers (`$any`, `$all`, `$none`), and `withDeleted` have no equivalent here and are rejected. Remove those config options before migration.
- TypeORM specific `buildCountQuery`, virtual columns, embedded path syntax, JSON path filters and optimized count behaviour are not ported. `optimizedCount` currently has no effect.
- The `$contains` operator follows MikroORM/PostgreSQL containment semantics; verify array and JSON filters against your schema.
- An unchanged TypeORM entity cannot be passed to MikroORM. Entity definitions, migrations, repository injection and transaction handling still require a real ORM migration.

Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, and `pnpm test` to verify this clone. The CI matrix runs the suite on MikroORM 6.6 and 7.2. SQLite integration tests exercise offset counts, filters, expressions, query builder scope, collection loading and cursor navigation. PostgreSQL-specific operators and relation-heavy queries still need integration tests against the target database before production use.

Publishing uses the tag-triggered GitHub Actions workflow and npm trusted publishing with provenance. Configure the GitHub repository and npm trusted publisher for this package before tagging a release; neither is created by this repository's workflow.
