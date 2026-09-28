import { BadRequestException } from '@nestjs/common'
import type { FilterQuery } from '@mikro-orm/core'
import { normalizeFilterExpression, parseFilterExpression, type NormalizedFilterExpression } from './filter-expression'
import { normalizeColumnPath } from './helper'

export enum FilterOperator {
    EQ = '$eq',
    GT = '$gt',
    GTE = '$gte',
    IN = '$in',
    NULL = '$null',
    LT = '$lt',
    LTE = '$lte',
    BTW = '$btw',
    ILIKE = '$ilike',
    SW = '$sw',
    CONTAINS = '$contains',
}
export enum FilterSuffix {
    NOT = '$not',
}
export enum FilterQuantifier {
    ALL = '$all',
    ANY = '$any',
    NONE = '$none',
}
export enum FilterComparator {
    AND = '$and',
    OR = '$or',
}

/** Config allow-list values; accepts literals and the existing enum members. */
export type FilterOption = `${FilterOperator}` | `${FilterSuffix}` | `${FilterQuantifier}`

export interface FilterToken {
    quantifier: FilterQuantifier
    comparator: FilterComparator
    suffix?: FilterSuffix
    operator: FilterOperator
    value?: string
}

export type FilterValueType =
    'string' | 'number' | 'boolean' | 'date' | 'date-only' | 'uuid' | { enum: readonly (string | number)[] }

const operators = new Set(Object.values(FilterOperator))
const quantifiers = new Set(Object.values(FilterQuantifier))

export function parseFilterToken(raw?: string): FilterToken | null {
    if (raw == null) return null
    const token: FilterToken = {
        quantifier: FilterQuantifier.ANY,
        comparator: FilterComparator.AND,
        operator: FilterOperator.EQ,
        value: raw,
    }
    const pieces = raw.split(':')
    let consumed = 0
    for (const piece of pieces.slice(0, 4)) {
        if (quantifiers.has(piece as FilterQuantifier)) token.quantifier = piece as FilterQuantifier
        else if (piece === FilterSuffix.NOT) token.suffix = FilterSuffix.NOT
        else if (piece === FilterComparator.OR || piece === FilterComparator.AND) token.comparator = piece
        else if (operators.has(piece as FilterOperator)) token.operator = piece as FilterOperator
        else break
        consumed++
    }
    token.value = token.operator === FilterOperator.NULL ? undefined : pieces.slice(consumed).join(':')
    return token
}

function columnCondition(
    column: string,
    value: unknown,
    quantifier: FilterQuantifier,
    collections: ReadonlySet<string>
): FilterQuery<never> {
    const path = normalizeColumnPath(column).split('.')
    return path.reduceRight((acc, key, index) => {
        const relationPath = path.slice(0, index + 1).join('.')
        if (collections.has(relationPath)) {
            if (quantifier === FilterQuantifier.ALL) {
                return { $and: [{ [key]: { $some: {} } }, { [key]: { $every: acc } }] }
            }
            return { [key]: { [quantifier === FilterQuantifier.NONE ? '$none' : '$some']: acc } }
        }
        return { [key]: acc }
    }, value) as FilterQuery<never>
}

function typedValue(value: string, kind?: FilterValueType): unknown {
    if (typeof kind === 'object') {
        const matched = kind.enum.find((item) => String(item) === value)
        if (matched === undefined) throw new BadRequestException('Invalid enum filter value')
        return matched
    }
    if (kind === 'number') {
        const parsed = Number(value)
        if (!Number.isFinite(parsed)) throw new BadRequestException('Invalid number filter value')
        return parsed
    }
    if (kind === 'boolean') {
        if (value !== 'true' && value !== 'false') throw new BadRequestException('Invalid boolean filter value')
        return value === 'true'
    }
    if (kind === 'date') {
        const date = new Date(value)
        if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date filter value')
        return date
    }
    if (kind === 'date-only') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
            throw new BadRequestException('Invalid date filter value')
        }
        const normalized = new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10)
        if (normalized !== value) throw new BadRequestException('Invalid date filter value')
        return value
    }
    if (kind === 'uuid') {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
            throw new BadRequestException('Invalid UUID filter value')
        }
        return value
    }
    return value
}

export function filterCondition<T>(
    column: string,
    raw: string,
    allowed: Record<string, FilterOption[] | true>,
    kinds: Record<string, FilterValueType> = {},
    collections: ReadonlySet<string> = new Set(),
    caseInsensitiveOperator: '$ilike' | '$like' = '$ilike'
): FilterQuery<T> {
    if (!(column in allowed)) throw new BadRequestException(`Column '${column}' is not filterable`)
    const token = parseFilterToken(raw)
    if (!token) throw new BadRequestException('Invalid filter')
    const permitted = allowed[column]
    if (
        permitted !== true &&
        ((token.operator !== FilterOperator.EQ && !permitted.includes(token.operator)) ||
            (token.suffix && !permitted.includes(token.suffix)) ||
            (token.quantifier !== FilterQuantifier.ANY && !permitted.includes(token.quantifier)))
    )
        throw new BadRequestException(`Filter operator is not allowed for '${column}'`)
    if (token.quantifier !== FilterQuantifier.ANY && ![...collections].some((path) => column.startsWith(`${path}.`))) {
        throw new BadRequestException('Relation quantifier requires a to-many relation')
    }
    const rawValue = token.value ?? ''
    const convert = (v: string) => typedValue(v.trim(), kinds[column])
    let value: unknown
    switch (token.operator) {
        case FilterOperator.EQ:
            value = { $eq: convert(rawValue) }
            break
        case FilterOperator.GT:
            value = { $gt: convert(rawValue) }
            break
        case FilterOperator.GTE:
            value = { $gte: convert(rawValue) }
            break
        case FilterOperator.LT:
            value = { $lt: convert(rawValue) }
            break
        case FilterOperator.LTE:
            value = { $lte: convert(rawValue) }
            break
        case FilterOperator.IN:
            value = { $in: rawValue.split(',').map(convert) }
            break
        case FilterOperator.NULL:
            value = token.suffix ? { $ne: null } : null
            break
        case FilterOperator.BTW: {
            const parts = rawValue.split(',')
            if (parts.length !== 2) throw new BadRequestException('Between requires two values')
            value = { $gte: convert(parts[0]), $lte: convert(parts[1]) }
            break
        }
        case FilterOperator.ILIKE:
            value = { [caseInsensitiveOperator]: `%${rawValue}%` }
            break
        case FilterOperator.SW:
            value = { [caseInsensitiveOperator]: `${rawValue}%` }
            break
        case FilterOperator.CONTAINS:
            value = { $contains: rawValue.split(',').map(convert) }
            break
    }
    if (token.suffix && token.operator !== FilterOperator.NULL) value = { $not: value }
    return columnCondition(column, value, token.quantifier, collections) as FilterQuery<T>
}

export function expressionCondition<T>(
    input: string,
    allowed: Record<string, FilterOption[] | true>,
    kinds: Record<string, FilterValueType>,
    maxComplexity: number,
    collections: ReadonlySet<string> = new Set(),
    caseInsensitiveOperator: '$ilike' | '$like' = '$ilike',
    leafCondition?: (column: string, raw: string) => FilterQuery<T>
): FilterQuery<T> {
    const tree = normalizeFilterExpression(parseFilterExpression(input, maxComplexity))
    const visit = (node: NormalizedFilterExpression): FilterQuery<T> => {
        if (node.type === 'leaf') {
            const condition = leafCondition
                ? leafCondition(node.column, node.value)
                : filterCondition<T>(node.column, node.value, allowed, kinds, collections, caseInsensitiveOperator)
            return node.negated ? ({ $not: condition } as FilterQuery<T>) : condition
        }
        return { [node.type === 'and' ? '$and' : '$or']: node.children.map(visit) } as FilterQuery<T>
    }
    return visit(tree)
}
