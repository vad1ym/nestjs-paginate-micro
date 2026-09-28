# nestjs-paginate-micro

Inspired by [nestjs-paginate](https://github.com/ppetzold/nestjs-paginate).

Filtering, search, sorting, and pagination for MikroORM in NestJS. Accepts a MikroORM repository or SQL query builder and returns `{ data, meta, links }`.

## Install

```sh
pnpm add nestjs-paginate-micro
# or
npm install nestjs-paginate-micro
# or
yarn add nestjs-paginate-micro
```

Your app also needs `@mikro-orm/core`, a matching MikroORM SQL driver, `@nestjs/common`, and `@nestjs/swagger`. The injection example uses `@mikro-orm/nestjs`. Supported: MikroORM 6.6/7.x, NestJS 11/12, Node 24+, PostgreSQL, MySQL/MariaDB, and SQLite. CI tests MikroORM 6.6/7.2 with NestJS 11/12; live-DB tests cover PostgreSQL and MariaDB, plus SQLite in-memory. Both ESM and CommonJS builds are included.

## Quick start

Register `Article` with `MikroOrmModule.forFeature([Article])`, then inject its repository:

```ts
import { Controller, Get } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import type { EntityRepository } from '@mikro-orm/core'
import { Paginate, paginate, type PaginateQuery } from 'nestjs-paginate-micro'
import { Article } from './article.entity'

@Controller('articles')
export class ArticlesController {
  constructor(
    @InjectRepository(Article)
    private readonly articles: EntityRepository<Article>,
  ) {}

  @Get()
  list(@Paginate() query: PaginateQuery) {
    return paginate(query, this.articles, {
      sortableColumns: ['id'],
    })
  }
}
```

`GET /articles?page=2&limit=20` returns `data`, page/count metadata, and navigation links. `sortableColumns` is required; its first field sorts ascending unless `defaultSortBy` is set. Default page size is 20, capped at 100.

## Query parameters

Only fields exposed by the endpoint config can be searched, sorted, filtered, or selected.

| Parameter | Example | Meaning |
| --- | --- | --- |
| `page`, `limit` | `?page=2&limit=20` | Offset page and size. Invalid values return 400. |
| `sortBy` | `?sortBy=createdAt:DESC&sortBy=id:ASC` | Repeat for multi-column sorting; fields must be in `sortableColumns`. |
| `search` | `?search=mikro` | Search fields in `searchableColumns`. |
| `searchBy` | `?search=mikro&searchBy=title` | Narrow search to an allowed field; repeat for more fields. |
| `filter.<field>` | `?filter.status=published` | Filter an allow-listed field; repeat for AND/OR conditions. |
| `filter` | `?filter=status=published` | Boolean filter expression; see below. |
| `select` | `?select=id,title` | Select fields permitted by config `select`. |
| `cursor` | `?cursor=...` | Continue a cursor page; follow `links.next`/`links.previous`. |
| `withDeleted` | `?withDeleted=true` | Include soft-deleted rows only when explicitly enabled. |

`limit=0` returns only a count. Unbounded `limit=-1` works only with `maxLimit: -1`; do not expose it on an unrestricted public endpoint.

## Search, sort, and filters

Add fields to the inline config in `list()`:

```ts
return paginate(query, this.articles, {
  sortableColumns: ['id', 'createdAt', 'title'],
  defaultSortBy: [['createdAt', 'DESC'], ['id', 'DESC']],
  searchableColumns: ['title'],
  filterableColumns: {
    status: ['$in', '$not'],
    price: ['$gte', '$lte', '$btw'],
    createdAt: ['$gte', '$lte'],
  },
})
```

Use string literals for allowed operators, suffixes, and relation quantifiers; the exported `FilterOperator`, `FilterSuffix`, and `FilterQuantifier` enums also work. A plain value or `$eq:value` performs equality for any listed field; `true` enables all operators. The array enables additional operations. For example:

```text
GET /articles?search=orm&sortBy=createdAt:DESC&filter.status=published
GET /articles?filter.price=$gte:10&filter.price=$lte:50
GET /articles?filter.status=$in:draft,published
GET /articles?filter.status=$not:published
```

| Syntax | Effect |
| --- | --- |
| `$eq:value`, `$gt:value`, `$gte:value`, `$lt:value`, `$lte:value` | Comparison. |
| `$in:a,b`, `$btw:a,b` | Set membership or inclusive range. |
| `$null`, `$not:$null` | Null / not null. |
| `$ilike:text`, `$sw:text` | Contains / starts-with search; case sensitivity on MySQL/SQLite follows collation and `LIKE` behavior. |
| `$contains:a,b` | Database-specific contains operation; check your column type/driver. |
| `$not:$eq:value` | Negate an operator; requires `'$not'` in the allow-list. |

Repeated values are ANDed unless a later value starts with `$or:`: `?filter.status=draft&filter.status=$or:published`. For more complex logic, use the single `filter=` parameter:

```text
filter=(status=draft OR status=published) AND price=$gte:10
```

URL-encode spaces and parentheses in actual requests. Expression fields use the same allow-list and operators as `filter.<field>`. Expression complexity is capped at 100 nodes by default.

MikroORM entity metadata supplies number, boolean, `Date`, date-only, UUID, and enum value types, so invalid values return 400 without per-field parsers. Override ambiguous metadata with `filterValueTypes: { publishedOn: 'date-only' }`. Unknown/invalid filters return 400 by default; `throwOnInvalidFilter: false` restores ignore behavior.

## Relations, JSON, and scoped queries

Use MikroORM property paths in allow-lists. `relations` populates the returned entities; a path can also be filtered without being populated.

```ts
return paginate(query, this.articles, {
  sortableColumns: ['id', 'author.name', 'details.label'],
  filterableColumns: {
    'author.name': ['$ilike'],
    'tags.name': ['$any', '$none', '$all'],
    'details.label': true,
  },
  relations: { author: true, tags: true },
  where: { published: true }, // fixed server-side scope
})
```

For to-many relation filters:

```text
?filter.author.name=$ilike:alex
?filter.tags.name=$any:typescript
?filter.tags.name=$none:archived
?filter.details.label=featured
```

`$all` requires a non-empty relation and matches when every related row satisfies the condition. Without a quantifier, to-many relation filters use `$any`. `where` may also be an array of conditions, combined with OR; client filters are added on top. JSON/embedded property paths and MikroORM `@Formula` properties can be allowed for filtering or sorting.

For an existing SQL scope, pass a query builder instead of a repository:

```ts
return paginate(query, this.articles.createQueryBuilder('a').where({ published: true }), {
  sortableColumns: ['id'],
  filterableColumns: { status: true },
})
```

The builder is modified by `paginate()`. Cursor pagination needs a repository. For fallback sorting, allow `nickname` and `title` in `sortableColumns`, then use `?sortBy=nickname~title:ASC`. This uses SQL `COALESCE` over scalar fields and also works for filters when both fields are filterable; `~` is offset-only.

## Cursor pagination

```ts
return paginate(query, this.articles, {
  sortableColumns: ['createdAt', 'id'],
  defaultSortBy: [['createdAt', 'DESC'], ['id', 'DESC']],
  paginationType: PaginationType.CURSOR,
})
```

Import `PaginationType`. Use a unique tie-breaker such as `id`, request `?limit=20`, then follow the returned `links.next` or `links.previous` URL. Cursor responses omit `totalItems` and `totalPages`. Cursor tokens from TypeORM's `nestjs-paginate` are not reusable.

## Soft delete

If your entity has a default-enabled MikroORM filter named `softDelete`:

```ts
return paginate(query, this.articles, {
  sortableColumns: ['id'],
  softDeleteFilter: 'softDelete',
  allowWithDeletedInQuery: true,
})
```

`?withDeleted=true` disables that filter for this query. Use `withDeleted: true` in config to always include deleted rows. The library does not invent a soft-delete convention or filter for your entities.

## Swagger

`PaginatedSwaggerDocs(Dto, config)` adds the pagination query parameters and a `{ data, meta, links }` response schema. Give it the same allow-lists as `paginate()`:

```ts
import { Controller, Get } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import type { EntityRepository } from '@mikro-orm/core'
import { ApiProperty } from '@nestjs/swagger'
import {
  Paginate,
  paginate,
  PaginatedSwaggerDocs,
  type PaginateQuery,
} from 'nestjs-paginate-micro'
import { Article } from './article.entity'

class ArticleDto {
  @ApiProperty()
  id!: number

  @ApiProperty()
  title!: string
}

@Controller('articles')
export class ArticlesController {
  constructor(
    @InjectRepository(Article)
    private readonly articles: EntityRepository<Article>,
  ) {}

  @Get()
  @PaginatedSwaggerDocs(ArticleDto, {
    sortableColumns: ['id', 'title'],
    searchableColumns: ['title'],
    filterableColumns: { status: ['$in'] },
  })
  list(@Paginate() query: PaginateQuery) {
    return paginate(query, this.articles, {
      sortableColumns: ['id', 'title'],
      searchableColumns: ['title'],
      filterableColumns: { status: ['$in'] },
    })
  }
}
```

This documents `page`, `limit`, `sortBy`, `search`, `searchBy`, and `filter.status`, plus the response. `ApiPaginationQuery(config)` documents only query parameters; `ApiOkPaginatedResponse(Dto, config)` documents only the response. The helper does not currently add `filter=` or `cursor` query parameters; document those with `@ApiQuery` if exposed. Its response schema describes offset metadata, so cursor endpoints may need a custom response schema. With inline configs, keep the decorator and runtime copies in sync.

## Config reference

A typical bounded list can combine these options without changing the controller shape:

```ts
return paginate(query, this.articles, {
  sortableColumns: ['id', 'publishedAt'],
  defaultSortBy: [['publishedAt', 'DESC'], ['id', 'DESC']],
  defaultLimit: 25,
  maxLimit: 50,
  select: ['id', 'title', 'publishedAt'],
  nullSort: 'last',
  relativePath: true,
  optimizedCount: true,
})
```

| Property | Purpose |
| --- | --- |
| `sortableColumns` | Required sorting allow-list; first field is the default ASC sort. |
| `defaultSortBy` | Default `[field, 'ASC' \| 'DESC']` pairs. |
| `searchableColumns`, `multiWordSearch` | Search allow-list; optionally require each search word to match. |
| `filterableColumns`, `filterValueTypes` | Filter allow-list and optional value-type overrides. |
| `where` | Fixed MikroORM condition; an array means OR. |
| `defaultLimit`, `maxLimit` | Default 20 and maximum 100. |
| `paginationType` | Offset by default; `CURSOR` uses MikroORM cursors. |
| `relations`, `loadStrategy` | Populate relations; separate/select-in loading is the default. |
| `defaultJoinMethod`, `joinMethods` | Optional left/inner join selection for configured relation paths. |
| `select` | Limit projected fields and allow client narrowing with `?select=...`; primary keys are retained. |
| `nullSort` | Put nulls `first` or `last` for sorting. |
| `ignoreSearchByInQueryParam`, `ignoreSelectInQueryParam` | Ignore those client overrides. |
| `softDeleteFilter`, `withDeleted`, `allowWithDeletedInQuery` | Control a named MikroORM soft-delete filter. |
| `optimizedCount`, `buildCountQuery` | Separate count query or custom MikroORM count builder. |
| `relativePath`, `origin` | Generate relative links or set their public origin. |
| `filterExpressionMaxComplexity`, `throwOnInvalidFilter` | Limit expression size; optionally ignore invalid filters. |
| `dialect` | Override SQL syntax with a custom `SqlDialect` implementation. |

`loadEagerRelations: false` is also available to suppress automatic eager population when no relations are explicitly listed. `LIMIT_AND_OFFSET` and `TAKE_AND_SKIP` both use offset pagination with MikroORM. For public APIs behind a proxy, set `origin` to your public base URL or use `relativePath: true` so links do not rely on the request Host header.

## Migrating from TypeORM + `nestjs-paginate`

Switch the import to `nestjs-paginate-micro`, inject a MikroORM repository, and keep the familiar `@Paginate()`/`paginate()` pattern. Query URLs and many config keys remain familiar, but this is not a TypeORM drop-in replacement. Replace TypeORM joins and `@VirtualColumn` with MikroORM relations and `@Formula`; rewrite `buildCountQuery` callbacks for MikroORM. Soft delete needs an explicit named MikroORM filter. Review existing clients for the stricter 400 responses and new cursor tokens.

## Development

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Optional live-DB tests use `PAGINATE_TEST_POSTGRES_URL` and `PAGINATE_TEST_MARIADB_URL` and recreate their dedicated schemas. CI covers MikroORM 6.6/7.2 with NestJS 11/12. CockroachDB selects the PostgreSQL dialect but is not in the live-DB test matrix. For another SQL driver, extend `SqlDialect` and pass an instance through `dialect`.

## Releases

The first npm publish must be done from an authenticated local session; the package must exist before npm can configure its GitHub Actions trusted publisher:

```sh
npm login
pnpm build
npm publish --access public
```

After npm shows `1.0.0`, configure Trusted Publishing for `vad1ym/nestjs-paginate-micro` and workflow `publish.yml` with direct `npm publish` allowed. Then create and push the tag with `git tag -a v1.0.0 -m v1.0.0` and `git push origin main v1.0.0`; the tag workflow skips an already-published version.

For later releases, use Conventional Commits, preview with `pnpm changelog:dry`, then run `pnpm release` and `git push origin main --follow-tags`. `changelogen` updates the changelog and creates the version commit/tag; pushing the tag starts the publish workflow. Do not use `pnpm release` for the already-set initial `1.0.0` version.
