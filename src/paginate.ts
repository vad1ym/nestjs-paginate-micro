import { BadRequestException, ServiceUnavailableException } from '@nestjs/common'
import { FilterQuery, LoadStrategy } from '@mikro-orm/core'
import { PaginateQuery } from './decorator'
import {
    FilterOperator,
    FilterQuantifier,
    FilterSuffix,
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
    positiveNumberOrDefault,
    relationPaths,
} from './helper'
import globalConfig from './global-config'

export { FilterOperator, FilterSuffix, FilterQuantifier }

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
    filterableColumns?: Partial<MappedColumns<T, (FilterOperator | FilterSuffix | FilterQuantifier)[] | true>>
    defaultSortBy?: SortBy<T>
    defaultLimit?: number
    maxLimit?: number
    paginationType?: PaginationType
    relations?: RelationSchemaInput<T>
    where?: FilterQuery<T>
    select?: Column<T>[]
    nullSort?: 'first' | 'last'
    multiWordSearch?: boolean
    ignoreSearchByInQueryParam?: boolean
    ignoreSelectInQueryParam?: boolean
    relativePath?: boolean
    origin?: string
    throwOnInvalidFilter?: boolean
    filterExpressionMaxComplexity?: number
    /** Explicit types for filter values when the entity metadata cannot infer them. */
    filterValueTypes?: Partial<Record<Column<T>, 'string' | 'number' | 'boolean' | 'date'>>
    /** Use MikroORM's separate relation loading for stable root entity pages. */
    loadStrategy?: LoadStrategy
    /** Kept for source compatibility; unsupported join strategy choices are rejected. */
    defaultJoinMethod?: JoinMethod
    joinMethods?: Partial<MappedColumns<T, JoinMethod>>
    loadEagerRelations?: boolean
    withDeleted?: boolean
    allowWithDeletedInQuery?: boolean
    optimizedCount?: boolean
}

/** A small structural contract for MikroORM QueryBuilder inputs. */
export interface MikroQueryBuilder<T extends object> {
    andWhere(condition: FilterQuery<T>): this
    orderBy(order: Record<string, string>): this
    limit(limit: number, offset?: number): this
    getResultAndCount(): Promise<[T[], number]>
    getResultList(): Promise<T[]>
    getCount(): Promise<number>
}

/** Structural interface accepted by SQL and base MikroORM repositories. */
export interface MikroRepository<T extends object> {
    findAndCount(where: any, options?: any): Promise<[T[], number]>
    count(where: any): Promise<number>
    getEntityName(): string
    getEntityManager(): unknown
}

function isRepository<T extends object>(input: MikroRepository<T> | MikroQueryBuilder<T>): input is MikroRepository<T> {
    return typeof (input as MikroRepository<T>).findAndCount === 'function'
}

function pathCondition<T extends object>(column: string, value: unknown): FilterQuery<T> {
    return column.split('.').reduceRight((acc, key) => ({ [key]: acc }), value) as FilterQuery<T>
}

function inferredValueTypes<T extends object>(input: MikroRepository<T>): Record<string, string> {
    const em = input.getEntityManager() as any
    const metadata = em.getMetadata()
    const root = metadata.get(input.getEntityName())
    const result: Record<string, string> = {}
    const walk = (meta: any, prefix = '', depth = 0) => {
        if (depth > 3) return
        for (const [name, property] of Object.entries(meta.properties) as [string, any][]) {
            const key = prefix ? `${prefix}.${name}` : name
            const type = String(property.runtimeType ?? property.type ?? '').toLowerCase()
            if (type === 'number' || type === 'boolean' || type === 'date') result[key] = type
            if (property.targetMeta) walk(property.targetMeta, key, depth + 1)
        }
    }
    walk(root)
    return result
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
    for (const [column, direction] of sortBy) params.append('sortBy', `${column}:${direction}`)
    if (query.search) params.set('search', query.search)
    if (query.search && query.searchBy && !config.ignoreSearchByInQueryParam) {
        for (const column of searchBy) params.append('searchBy', String(column))
    }
    for (const [column, raw] of Object.entries(query.filter ?? {})) {
        for (const value of Array.isArray(raw) ? raw : [raw]) params.append(`filter.${column}`, value)
    }
    if (query.filterExpression) params.set('filter', query.filterExpression)
    if (query.select?.length && !config.ignoreSelectInQueryParam) params.set('select', query.select.join(','))
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
    if (config.defaultJoinMethod || config.joinMethods) {
        throw new BadRequestException(
            'TypeORM join methods have no MikroORM equivalent; use relations and loadStrategy'
        )
    }
    if (config.withDeleted || (config.allowWithDeletedInQuery && query.withDeleted)) {
        throw new BadRequestException('withDeleted is not supported by this adapter')
    }
    const repo = isRepository(input)
    const page = positiveNumberOrDefault(query.page, 1)
    const maxLimit = config.maxLimit ?? globalConfig.defaultMaxLimit
    const defaultLimit = config.defaultLimit ?? globalConfig.defaultLimit
    const counterOnly = query.limit === PaginationLimit.COUNTER_ONLY
    const unpaged = query.limit === PaginationLimit.NO_PAGINATION && maxLimit === PaginationLimit.NO_PAGINATION
    const requestedLimit = positiveNumberOrDefault(query.limit, defaultLimit)
    const limit = counterOnly
        ? 0
        : unpaged || maxLimit === PaginationLimit.NO_PAGINATION
          ? requestedLimit
          : Math.min(requestedLimit, maxLimit)
    const sortBy = (query.sortBy ?? []).filter(
        ([column, direction]) =>
            (direction === 'ASC' || direction === 'DESC') &&
            (Array.isArray(column)
                ? column.every((c) => config.sortableColumns.includes(c))
                : config.sortableColumns.includes(column))
    ) as SortBy<T>
    if (!sortBy.length) sortBy.push(...(config.defaultSortBy ?? [[config.sortableColumns[0], 'ASC']]))
    if (sortBy.some(([column]) => Array.isArray(column))) {
        throw new BadRequestException('Polymorphic sort groups are not supported')
    }
    const searchBy = (
        query.searchBy && !config.ignoreSearchByInQueryParam
            ? query.searchBy.filter((c) => config.searchableColumns?.includes(c))
            : (config.searchableColumns ?? [])
    ) as Column<T>[]
    const conditions: FilterQuery<T>[] = []
    const platformName = repo ? (input.getEntityManager() as any).getDriver().getPlatform().constructor.name : ''
    const searchOperator = platformName.includes('Sqlite') ? '$like' : '$ilike'
    if (config.where) conditions.push(config.where)
    const allowed = (config.filterableColumns ?? {}) as Record<
        string,
        (FilterOperator | FilterSuffix | FilterQuantifier)[] | true
    >
    const kinds = {
        ...(repo ? inferredValueTypes(input) : {}),
        ...(config.filterValueTypes ?? {}),
    } as Record<string, string>
    for (const [column, raw] of Object.entries(query.filter ?? {})) {
        if (!(column in allowed)) {
            if (config.throwOnInvalidFilter) throw new BadRequestException(`Column '${column}' is not filterable`)
            continue
        }
        const values = Array.isArray(raw) ? raw : [raw]
        let combined: FilterQuery<T> | undefined
        for (const value of values) {
            const token = parseFilterToken(value)
            if (!token) continue
            try {
                const condition = filterCondition<T>(column, value, allowed, kinds)
                combined = combined
                    ? ({ [token.comparator === '$or' ? '$or' : '$and']: [combined, condition] } as FilterQuery<T>)
                    : condition
            } catch (error) {
                if (config.throwOnInvalidFilter) throw error
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
                config.filterExpressionMaxComplexity ?? globalConfig.defaultFilterExpressionMaxComplexity
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
        sortBy.map(([column, direction]) => [
            column,
            config.nullSort ? `${direction} NULLS ${config.nullSort.toUpperCase()}` : direction,
        ])
    ) as Record<string, string>
    const selected =
        config.select && query.select && !config.ignoreSelectInQueryParam
            ? config.select.filter((column) => query.select!.includes(String(column)))
            : config.select
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
            populate: relationPaths(config.relations as string[] | Record<string, unknown>),
            strategy: config.loadStrategy ?? LoadStrategy.SELECT_IN,
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
            for (const [column, direction] of sortBy) params.append('sortBy', `${column}:${direction}`)
            if (query.search) params.set('search', query.search)
            for (const [column, raw] of Object.entries(query.filter ?? {})) {
                for (const item of Array.isArray(raw) ? raw : [raw]) params.append(`filter.${column}`, item)
            }
            if (query.filterExpression) params.set('filter', query.filterExpression)
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
            populate: relationPaths(config.relations as string[] | Record<string, unknown>),
            strategy: config.loadStrategy ?? LoadStrategy.SELECT_IN,
            ...(selected ? { fields: selected } : {}),
            ...(!counterOnly && !unpaged ? { limit, offset: (page - 1) * limit } : {}),
        }
        if (counterOnly) totalItems = await input.count(where)
        else [data, totalItems] = (await input.findAndCount(where, options as any)) as [T[], number]
    } else {
        if (conditions.length) input.andWhere(where)
        input.orderBy(orderBy)
        if (!counterOnly && !unpaged) input.limit(limit, (page - 1) * limit)
        if (counterOnly) totalItems = await input.getCount()
        else [data, totalItems] = await input.getResultAndCount()
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
            select: selected ? selected.map(String) : undefined,
            filter: query.filter,
        },
        links: encodeLinks(query, config, limit, sortBy, searchBy, currentPage, totalPages),
    }
}
