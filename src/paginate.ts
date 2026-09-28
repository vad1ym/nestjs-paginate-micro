import { BadRequestException, ServiceUnavailableException } from '@nestjs/common'
import { FilterQuery, LoadStrategy, raw } from '@mikro-orm/core'
import { PaginateQuery } from './decorator'
import {
    FilterOperator,
    FilterQuantifier,
    FilterSuffix,
    type FilterOption,
    type FilterValueType,
    expressionCondition,
    filterCondition,
    parseFilterToken,
} from './filter'
import {
    Column,
    JoinMethod,
    MappedColumns,
    RelationSchemaInput,
    SortBy,
    relationPaths,
    normalizeColumnPath,
} from './helper'
import globalConfig from './global-config'
import { dialectFor, type SqlDialect } from './dialect'

export { FilterOperator, FilterSuffix, FilterQuantifier }
export type { FilterOption } from './filter'

export class Paginated<T> {
    data!: T[]
    meta!: {
        itemsPerPage: number
        totalItems?: number
        currentPage?: number
        totalPages?: number
        sortBy: SortBy<T>
        searchBy?: Column<T>[]
        search?: string
        select?: string[]
        filter?: Record<string, string | string[]>
        cursor?: string
    }
    links!: { first?: string; previous?: string; current?: string; next?: string; last?: string }
}

export enum PaginationType {
    LIMIT_AND_OFFSET = 'limit',
    TAKE_AND_SKIP = 'take',
    CURSOR = 'cursor',
}
export enum PaginationLimit {
    NO_PAGINATION = -1,
    COUNTER_ONLY = 0,
}

export interface PaginateConfig<T extends object> {
    sortableColumns: Column<T>[]
    searchableColumns?: Column<T>[]
    filterableColumns?: Partial<MappedColumns<T, FilterOption[] | true>>
    defaultSortBy?: SortBy<T>
    defaultLimit?: number
    maxLimit?: number
    paginationType?: PaginationType
    relations?: RelationSchemaInput<T>
    where?: FilterQuery<T> | FilterQuery<T>[]
    select?: Column<T>[]
    nullSort?: 'first' | 'last'
    multiWordSearch?: boolean
    ignoreSearchByInQueryParam?: boolean
    ignoreSelectInQueryParam?: boolean
    relativePath?: boolean
    origin?: string
    /** Reject unknown or invalid filters by default; set false for legacy ignore behavior. */
    throwOnInvalidFilter?: boolean
    filterExpressionMaxComplexity?: number
    /** Explicit types for filter values when the entity metadata cannot infer them. */
    filterValueTypes?: Partial<Record<Column<T>, FilterValueType>>
    /** Override SQL syntax for a custom driver. */
    dialect?: SqlDialect
    /** Use MikroORM's separate relation loading for stable root entity pages. */
    loadStrategy?: LoadStrategy
    /** Kept for source compatibility; unsupported join strategy choices are rejected. */
    defaultJoinMethod?: JoinMethod
    joinMethods?: Partial<MappedColumns<T, JoinMethod>>
    loadEagerRelations?: boolean
    withDeleted?: boolean
    allowWithDeletedInQuery?: boolean
    /** Name of the application's default-enabled MikroORM soft-delete filter. */
    softDeleteFilter?: string
    optimizedCount?: boolean
    /** Override a MikroORM count query; unlike TypeORM this callback receives a MikroORM builder. */
    buildCountQuery?: (queryBuilder: MikroQueryBuilder<T>) => MikroQueryBuilder<T>
}

/** A small structural contract for MikroORM QueryBuilder inputs. */
export interface MikroQueryBuilder<T extends object> {
    andWhere(condition: FilterQuery<T>): this
    orderBy(order: Record<string, string>): this
    limit(limit: number, offset?: number): this
    getResultAndCount(): Promise<[T[], number]>
    getResultList(): Promise<T[]>
    getCount(): Promise<number>
    clone?(): MikroQueryBuilder<T>
    select?(fields: string[]): this
}

/** Structural interface accepted by SQL and base MikroORM repositories. */
export interface MikroRepository<T extends object> {
    findAndCount(where: any, options?: any): Promise<[T[], number]>
    find?(where: any, options?: any): Promise<T[]>
    count(where: any, options?: any): Promise<number>
    createQueryBuilder?(alias?: string): MikroQueryBuilder<T>
    getEntityName(): string
    getEntityManager(): unknown
}

function isRepository<T extends object>(input: MikroRepository<T> | MikroQueryBuilder<T>): input is MikroRepository<T> {
    return typeof (input as MikroRepository<T>).findAndCount === 'function'
}

function pathCondition<T extends object>(column: string, value: unknown): FilterQuery<T> {
    return normalizeColumnPath(column)
        .split('.')
        .reduceRight((acc, key) => ({ [key]: acc }), value) as FilterQuery<T>
}

function inspectEntityPaths<T extends object>(
    input: MikroRepository<T> | MikroQueryBuilder<T>
): {
    kinds: Record<string, FilterValueType>
    collections: Set<string>
    primaryKeys: string[]
    metadata?: any
} {
    const root = isRepository(input)
        ? (input.getEntityManager() as any).getMetadata().get(input.getEntityName())
        : ((input as any).mainAlias?.meta ?? (input as any).mainAlias?.metadata)
    const kinds: Record<string, FilterValueType> = {}
    const collections = new Set<string>()
    const walk = (meta: any, prefix = '', depth = 0) => {
        if (!meta || depth > 5) return
        for (const [name, property] of Object.entries(meta.properties) as [string, any][]) {
            const key = prefix ? `${prefix}.${name}` : name
            const type = String(property.runtimeType ?? property.type ?? '').toLowerCase()
            const mappedType = String(property.type ?? '').toLowerCase()
            if (property.enum && Array.isArray(property.items) && !property.array) {
                kinds[key] = { enum: property.items }
            } else if (
                mappedType === 'uuid' ||
                property.columnTypes?.some((columnType: string) => /\buuid\b/i.test(columnType))
            ) {
                kinds[key] = 'uuid'
            } else if (mappedType === 'datetype' || (type === 'string' && property.columnTypes?.includes('date'))) {
                kinds[key] = 'date-only'
            } else if (type === 'number' || type === 'boolean' || type === 'date') {
                kinds[key] = type
            }
            if (property.kind === '1:m' || property.kind === 'm:n') collections.add(key)
            if (property.targetMeta) walk(property.targetMeta, key, depth + 1)
        }
    }
    walk(root)
    return { kinds, collections, primaryKeys: root?.primaryKeys ?? [], metadata: root }
}

function expandSelect(columns: readonly string[], metadata: any): string[] {
    const expanded: string[] = []
    for (const column of columns) {
        if (column !== '*' && !column.endsWith('.*')) {
            expanded.push(normalizeColumnPath(column))
            continue
        }
        const relationPath = column === '*' ? '' : column.slice(0, -2)
        let current = metadata
        for (const segment of relationPath ? relationPath.split('.') : []) {
            current = current?.properties?.[segment]?.targetMeta
        }
        if (!current) throw new BadRequestException(`Unknown select path: ${column}`)
        for (const [name, property] of Object.entries(current.properties) as [string, any][]) {
            if (property.kind === 'scalar' || property.kind === 'embedded') {
                expanded.push(relationPath ? `${relationPath}.${name}` : name)
            }
        }
    }
    return [...new Set(expanded)]
}

function jsonColumn(metadata: any, column: string): { relations: string[]; field: string; path: string[] } | undefined {
    const parts = column.split('.')
    const relations: string[] = []
    let current = metadata
    for (let index = 0; index < parts.length - 1; index++) {
        const property = current?.properties?.[parts[index]]
        if (property?.targetMeta) {
            relations.push(parts[index])
            current = property.targetMeta
            continue
        }
        if (property && /json/i.test(String(property.type ?? ''))) {
            return { relations, field: property.fieldNames?.[0] ?? parts[index], path: parts.slice(index + 1) }
        }
        return undefined
    }
    return undefined
}

function joinToOneRelations<T extends object>(
    input: MikroQueryBuilder<T>,
    metadata: any,
    relations: readonly string[],
    joins: Set<string>
): { alias: string; metadata: any } {
    let current = metadata
    let alias = (input as any).alias ?? '__root'
    let prefix = ''
    for (const relationName of relations) {
        const property = current?.properties?.[relationName]
        if (!property?.targetMeta || property.kind === '1:m' || property.kind === 'm:n') {
            throw new BadRequestException(`SQL column must use to-one relations: ${relations.join('.')}`)
        }
        prefix = prefix ? `${prefix}.${relationName}` : relationName
        const nextAlias = `__paginate_${prefix.replace(/[^a-zA-Z0-9]/g, '_')}`
        if (!joins.has(prefix)) {
            ;(input as any).leftJoin(`${alias}.${relationName}`, nextAlias)
            joins.add(prefix)
        }
        alias = nextAlias
        current = property.targetMeta
    }
    return { alias, metadata: current }
}

function polymorphicColumnSql<T extends object>(
    input: MikroQueryBuilder<T>,
    metadata: any,
    column: string,
    platform: any,
    joins: Set<string>
): string {
    const parts = normalizeColumnPath(column).split('.')
    const joined = joinToOneRelations(input, metadata, parts.slice(0, -1), joins)
    const current = joined.metadata
    const alias = joined.alias
    const leaf = current?.properties?.[parts.at(-1)!]
    if (!leaf || leaf.kind !== 'scalar' || /json/i.test(String(leaf.type ?? ''))) {
        throw new BadRequestException(`Polymorphic column must be a scalar: ${column}`)
    }
    return `${platform.quoteIdentifier(alias)}.${platform.quoteIdentifier(leaf.fieldNames?.[0] ?? leaf.name)}`
}

function encodeLinks<T extends object>(
    query: PaginateQuery,
    config: PaginateConfig<T>,
    limit: number,
    sortBy: SortBy<T>,
    searchBy: Column<T>[],
    page: number,
    totalPages: number
): Paginated<T>['links'] {
    if (query.path == null) return {}
    const url = new URL(query.path)
    const origin = config.origin ?? globalConfig.defaultOrigin ?? url.origin
    const base = (config.relativePath ? '' : origin) + url.pathname
    const params = new URLSearchParams()
    params.set('limit', String(limit))
    for (const [column, direction] of sortBy) {
        params.append('sortBy', `${Array.isArray(column) ? column.join('~') : column}:${direction}`)
    }
    if (query.search) params.set('search', query.search)
    if (query.search && query.searchBy && !config.ignoreSearchByInQueryParam) {
        for (const column of searchBy) params.append('searchBy', String(column))
    }
    for (const [column, raw] of Object.entries(query.filter ?? {})) {
        for (const value of Array.isArray(raw) ? raw : [raw]) params.append(`filter.${column}`, value)
    }
    if (query.filterExpression) params.set('filter', query.filterExpression)
    if (query.select?.length && !config.ignoreSelectInQueryParam) params.set('select', query.select.join(','))
    if (config.allowWithDeletedInQuery && query.withDeleted !== undefined) {
        params.set('withDeleted', String(query.withDeleted))
    }
    const at = (number: number) => {
        const copy = new URLSearchParams(params)
        copy.set('page', String(number))
        return `${base}?${copy}`
    }
    return {
        first: page > 1 ? at(1) : undefined,
        previous: page > 1 ? at(page - 1) : undefined,
        current: at(page),
        next: page < totalPages ? at(page + 1) : undefined,
        last: page < totalPages ? at(totalPages) : undefined,
    }
}

/** Apply a nestjs-paginate query to a MikroORM repository or query builder. */
export async function paginate<T extends object>(
    query: PaginateQuery,
    input: MikroRepository<T> | MikroQueryBuilder<T>,
    config: PaginateConfig<T>
): Promise<Paginated<T>> {
    if (!config.sortableColumns?.length)
        throw new ServiceUnavailableException("Missing required 'sortableColumns' config.")
    const includeDeleted = config.withDeleted || (config.allowWithDeletedInQuery && query.withDeleted)
    if (includeDeleted && !config.softDeleteFilter) {
        throw new BadRequestException('Set softDeleteFilter to the name of your MikroORM soft-delete filter')
    }
    const filters = includeDeleted ? { [config.softDeleteFilter!]: false } : undefined
    const repo = isRepository(input)
    const relationList = [
        ...new Set([
            ...relationPaths(config.relations as string[] | Record<string, unknown>),
            ...Object.keys(config.joinMethods ?? {}),
        ]),
    ]
    const hasJoinSettings = Boolean(config.defaultJoinMethod || config.joinMethods)
    const populateHints = hasJoinSettings
        ? Object.fromEntries(
              relationList.map((path) => [
                  path,
                  {
                      strategy: LoadStrategy.JOINED,
                      joinType: (config.joinMethods?.[path] ?? config.defaultJoinMethod)?.startsWith('inner')
                          ? 'inner join'
                          : 'left join',
                  },
              ])
          )
        : undefined
    const populate = config.loadEagerRelations === false && relationList.length === 0 ? false : relationList
    const strategy = hasJoinSettings ? LoadStrategy.JOINED : (config.loadStrategy ?? LoadStrategy.SELECT_IN)
    if (query.page !== undefined && (!Number.isSafeInteger(query.page) || query.page < 1)) {
        throw new BadRequestException('Invalid page')
    }
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < -1)) {
        throw new BadRequestException('Invalid limit')
    }
    const page = query.page ?? 1
    const maxLimit = config.maxLimit ?? globalConfig.defaultMaxLimit
    const defaultLimit = config.defaultLimit ?? globalConfig.defaultLimit
    const counterOnly = query.limit === PaginationLimit.COUNTER_ONLY
    const unpaged = query.limit === PaginationLimit.NO_PAGINATION && maxLimit === PaginationLimit.NO_PAGINATION
    const requestedLimit = query.limit && query.limit > 0 ? query.limit : defaultLimit
    const limit = counterOnly
        ? 0
        : unpaged || maxLimit === PaginationLimit.NO_PAGINATION
          ? requestedLimit
          : Math.min(requestedLimit, maxLimit)
    if (config.paginationType === PaginationType.CURSOR && (counterOnly || unpaged)) {
        throw new BadRequestException('Cursor pagination requires a positive limit')
    }
    const sortBy = (query.sortBy ?? []).filter(
        ([column, direction]) =>
            (direction === 'ASC' || direction === 'DESC') &&
            (Array.isArray(column)
                ? column.every((c) => config.sortableColumns.includes(c))
                : config.sortableColumns.includes(column))
    ) as SortBy<T>
    if (!sortBy.length) sortBy.push(...(config.defaultSortBy ?? [[config.sortableColumns[0], 'ASC']]))
    const entityPaths = inspectEntityPaths(input)
    const polymorphicSort = sortBy.some(([column]) => Array.isArray(column))
    const relationJsonSort = sortBy.some(
        ([column]) =>
            typeof column === 'string' &&
            Boolean(jsonColumn(entityPaths.metadata, normalizeColumnPath(column))?.relations.length)
    )
    const polymorphicFilter =
        Object.keys(query.filter ?? {}).some((column) => column.includes('~')) ||
        Boolean(query.filterExpression?.includes('~'))
    if ((polymorphicSort || polymorphicFilter) && config.paginationType === PaginationType.CURSOR) {
        throw new BadRequestException('Polymorphic columns are not supported with cursors')
    }
    if (repo && (polymorphicSort || polymorphicFilter || relationJsonSort)) {
        if (!input.createQueryBuilder) throw new BadRequestException('Polymorphic columns require a SQL repository')
        const result = await paginate(query, input.createQueryBuilder('__root'), config)
        const relations = relationPaths(config.relations as string[] | Record<string, unknown>)
        if (relations.length) {
            await (input.getEntityManager() as any).populate(result.data, relations)
        }
        return result
    }
    const searchBy = (
        query.searchBy && !config.ignoreSearchByInQueryParam
            ? query.searchBy.filter((c) => config.searchableColumns?.includes(c))
            : (config.searchableColumns ?? [])
    ) as Column<T>[]
    const conditions: FilterQuery<T>[] = []
    const platform = repo
        ? (input.getEntityManager() as any).getDriver().getPlatform()
        : (input as any).driver?.getPlatform()
    const dialect = config.dialect ?? dialectFor(platform?.constructor.name ?? '')
    const searchOperator = dialect.caseInsensitiveOperator
    if (config.where) {
        conditions.push(Array.isArray(config.where) ? ({ $or: config.where } as FilterQuery<T>) : config.where)
    }
    for (const path of relationList) {
        if (!(config.joinMethods?.[path] ?? config.defaultJoinMethod)?.startsWith('inner')) continue
        conditions.push(pathCondition<T>(path, entityPaths.collections.has(path) ? { $some: {} } : { $ne: null }))
    }
    const allowed = (config.filterableColumns ?? {}) as Record<string, FilterOption[] | true>
    const kinds = {
        ...entityPaths.kinds,
        ...(config.filterValueTypes ?? {}),
    } as Record<string, FilterValueType>
    const joins = new Set<string>()
    const isAllowed = (column: string) =>
        column in allowed || (column.includes('~') && column.split('~').every((part) => part in allowed))
    const makeFilterCondition = (column: string, value: string): FilterQuery<T> => {
        if (!column.includes('~')) {
            return filterCondition<T>(column, value, allowed, kinds, entityPaths.collections, searchOperator)
        }
        const parts = column.split('~')
        if (parts.length < 2 || parts.some((part) => !part)) throw new BadRequestException('Invalid polymorphic column')
        const permission = allowed[column]
        if (permission === undefined) {
            for (const part of parts) {
                filterCondition<T>(part, value, allowed, kinds, entityPaths.collections, searchOperator)
            }
        }
        const surrogate = '__paginate_polymorphic_value'
        const wrapped = filterCondition<Record<string, unknown>>(
            surrogate,
            value,
            { [surrogate]: permission ?? allowed[parts[0]] },
            { [surrogate]: kinds[column] ?? kinds[parts[0]] },
            new Set(),
            searchOperator
        ) as Record<string, unknown>
        const expression = dialect.coalesce(
            parts.map((part) =>
                polymorphicColumnSql(input as MikroQueryBuilder<T>, entityPaths.metadata, part, platform, joins)
            )
        )
        return { [raw(expression)]: wrapped[surrogate] } as FilterQuery<T>
    }
    for (const [column, raw] of Object.entries(query.filter ?? {})) {
        if (!isAllowed(column)) {
            if (config.throwOnInvalidFilter !== false)
                throw new BadRequestException(`Column '${column}' is not filterable`)
            continue
        }
        const values = Array.isArray(raw) ? raw : [raw]
        let combined: FilterQuery<T> | undefined
        for (const value of values) {
            const token = parseFilterToken(value)
            if (!token) continue
            try {
                const condition = makeFilterCondition(column, value)
                combined = combined
                    ? ({ [token.comparator === '$or' ? '$or' : '$and']: [combined, condition] } as FilterQuery<T>)
                    : condition
            } catch (error) {
                if (config.throwOnInvalidFilter !== false) throw error
            }
        }
        if (combined) conditions.push(combined)
    }
    if (query.filterExpression) {
        conditions.push(
            expressionCondition<T>(
                query.filterExpression,
                allowed,
                kinds,
                config.filterExpressionMaxComplexity ?? globalConfig.defaultFilterExpressionMaxComplexity,
                entityPaths.collections,
                searchOperator,
                makeFilterCondition
            )
        )
    }
    if (query.search && searchBy.length) {
        const words = config.multiWordSearch ? query.search.split(/\s+/).filter(Boolean) : [query.search]
        for (const word of words) {
            conditions.push({
                $or: searchBy.map((column) => pathCondition<T>(String(column), { [searchOperator]: `%${word}%` })),
            } as FilterQuery<T>)
        }
    }
    const where = conditions.length ? ({ $and: conditions } as FilterQuery<T>) : ({} as FilterQuery<T>)
    const orderBy = Object.fromEntries(
        sortBy.flatMap(([column, direction]) => {
            if (Array.isArray(column)) {
                const expression = dialect.coalesce(
                    column.map((part) =>
                        polymorphicColumnSql(input as MikroQueryBuilder<T>, entityPaths.metadata, part, platform, joins)
                    )
                )
                return [[raw(expression), direction]]
            }
            const normalized = normalizeColumnPath(String(column))
            const json = jsonColumn(entityPaths.metadata, normalized)
            const jsonAlias = json?.relations.length
                ? joinToOneRelations(input as MikroQueryBuilder<T>, entityPaths.metadata, json.relations, joins).alias
                : undefined
            const sqlReference = json
                ? dialect.jsonScalar(
                      jsonAlias
                          ? `${platform.quoteIdentifier(jsonAlias)}.${platform.quoteIdentifier(json.field)}`
                          : platform.quoteIdentifier(json.field),
                      json.path
                  )
                : platform.quoteIdentifier(
                      entityPaths.metadata?.properties?.[normalized]?.fieldNames?.[0] ?? normalized
                  )
            if (config.nullSort) {
                return dialect
                    .nullSort(sqlReference, direction, config.nullSort)
                    .map(([expression, order]) => [raw(expression), order])
            }
            return [[json ? raw(sqlReference) : normalized, direction]]
        })
    ) as Record<string, string>
    const allowedSelect = config.select ? expandSelect(config.select.map(String), entityPaths.metadata) : undefined
    const requestedSelect =
        query.select && !config.ignoreSelectInQueryParam ? expandSelect(query.select, entityPaths.metadata) : undefined
    const selected =
        allowedSelect && requestedSelect
            ? allowedSelect.filter((column) => requestedSelect.includes(column))
            : allowedSelect
    const selectedFields = selected?.length ? [...new Set([...selected, ...entityPaths.primaryKeys])] : undefined
    let data: T[] = []
    let totalItems = 0
    if (config.paginationType === PaginationType.CURSOR) {
        if (!repo) throw new BadRequestException('Cursor pagination requires a MikroORM repository')
        const backward = query.cursor?.startsWith('prev:')
        const cursorValue = backward ? query.cursor!.slice(5) : query.cursor
        const cursorOptions = {
            where,
            orderBy,
            ...(backward ? { last: limit, before: cursorValue } : { first: limit, after: cursorValue }),
            populate,
            strategy,
            ...(populateHints ? { populateHints } : {}),
            ...(filters ? { filters } : {}),
            ...(selectedFields ? { fields: selectedFields } : {}),
            includeCount: false,
        }
        const findByCursor = (input as any).findByCursor.bind(input)
        const cursor = await (findByCursor.length >= 2
            ? findByCursor(where, cursorOptions)
            : findByCursor(cursorOptions))
        data = cursor.items as T[]
        const cursorLink = (value: string | null, previous = false) => {
            const params = new URLSearchParams()
            params.set('limit', String(limit))
            for (const [column, direction] of sortBy) {
                params.append('sortBy', `${Array.isArray(column) ? column.join('~') : column}:${direction}`)
            }
            if (query.search) params.set('search', query.search)
            if (query.search && query.searchBy && !config.ignoreSearchByInQueryParam) {
                for (const column of searchBy) params.append('searchBy', String(column))
            }
            for (const [column, raw] of Object.entries(query.filter ?? {})) {
                for (const item of Array.isArray(raw) ? raw : [raw]) params.append(`filter.${column}`, item)
            }
            if (query.filterExpression) params.set('filter', query.filterExpression)
            if (query.select?.length && !config.ignoreSelectInQueryParam) {
                params.set('select', query.select.join(','))
            }
            if (config.allowWithDeletedInQuery && query.withDeleted !== undefined) {
                params.set('withDeleted', String(query.withDeleted))
            }
            if (value) params.set('cursor', previous ? `prev:${value}` : value)
            const url = new URL(query.path!)
            const origin = config.origin ?? globalConfig.defaultOrigin ?? url.origin
            const base = (config.relativePath ? '' : origin) + url.pathname
            return base + '?' + params
        }
        return {
            data,
            meta: {
                itemsPerPage: data.length,
                sortBy,
                searchBy: query.search ? searchBy : undefined,
                search: query.search,
                select: requestedSelect ? selected : undefined,
                filter: query.filter,
                cursor: query.cursor,
            },
            links:
                query.path == null
                    ? {}
                    : {
                          previous: cursor.hasPrevPage ? cursorLink(cursor.startCursor, true) : undefined,
                          current: cursorLink(query.cursor ?? null),
                          next: cursor.hasNextPage ? cursorLink(cursor.endCursor) : undefined,
                      },
        }
    }
    if (repo) {
        const options = {
            orderBy,
            populate,
            strategy,
            ...(populateHints ? { populateHints } : {}),
            ...(filters ? { filters } : {}),
            ...(selectedFields ? { fields: selectedFields } : {}),
            ...(!counterOnly && !unpaged ? { limit, offset: (page - 1) * limit } : {}),
        }
        if (counterOnly) {
            totalItems = await input.count(where, filters ? { filters } : undefined)
        } else if (config.optimizedCount || config.buildCountQuery) {
            if (!input.find) throw new BadRequestException('This repository does not implement find()')
            data = await input.find(where, options as any)
            if (config.buildCountQuery) {
                if (!input.createQueryBuilder) {
                    throw new BadRequestException('buildCountQuery requires a SQL repository')
                }
                const countBuilder = input.createQueryBuilder('__root')
                if (typeof (countBuilder as any).applyFilters === 'function') {
                    await (countBuilder as any).applyFilters(filters ?? {})
                }
                countBuilder.andWhere(where)
                totalItems = await config.buildCountQuery(countBuilder).getCount()
            } else {
                totalItems = await input.count(where, filters ? { filters } : undefined)
            }
        } else {
            ;[data, totalItems] = (await input.findAndCount(where, options as any)) as [T[], number]
        }
    } else {
        if (typeof (input as any).applyFilters === 'function') {
            await (input as any).applyFilters(filters ?? {})
        }
        if (conditions.length) input.andWhere(where)
        const countBuilder = (config.optimizedCount || config.buildCountQuery) && input.clone?.()
        if (selectedFields && input.select) input.select(selectedFields)
        input.orderBy(orderBy)
        if (!counterOnly && !unpaged) input.limit(limit, (page - 1) * limit)
        if (counterOnly) totalItems = await input.getCount()
        else if (config.optimizedCount || config.buildCountQuery) {
            if (!countBuilder) throw new BadRequestException('Optimized count requires a cloneable query builder')
            data = await input.getResultList()
            totalItems = await (config.buildCountQuery?.(countBuilder) ?? countBuilder).getCount()
        } else [data, totalItems] = await input.getResultAndCount()
    }
    const totalPages = unpaged ? 1 : counterOnly ? 0 : Math.ceil(totalItems / limit)
    const currentPage = Math.max(1, Math.min(page, totalPages || 1))
    return {
        data,
        meta: {
            itemsPerPage: counterOnly ? totalItems : unpaged ? data.length : limit,
            totalItems,
            currentPage,
            totalPages,
            sortBy,
            search: query.search,
            searchBy: query.search ? searchBy : undefined,
            select: requestedSelect ? selected : undefined,
            filter: query.filter,
        },
        links: encodeLinks(query, config, limit, sortBy, searchBy, currentPage, totalPages),
    }
}
