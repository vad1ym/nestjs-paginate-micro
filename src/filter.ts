import { BadRequestException } from '@nestjs/common'
import type { FilterQuery } from '@mikro-orm/core'
import { normalizeFilterExpression, parseFilterExpression, type NormalizedFilterExpression } from './filter-expression'

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

export interface FilterToken {
    quantifier: FilterQuantifier
    comparator: FilterComparator
    suffix?: FilterSuffix
    operator: FilterOperator
    value?: string
}

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

function columnCondition(column: string, value: unknown): FilterQuery<never> {
    const path = column.split('.')
    return path.reduceRight((acc, key) => ({ [key]: acc }), value) as FilterQuery<never>
}

function typedValue(value: string, kind?: string): unknown {
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
    return value
}

export function filterCondition<T>(
    column: string,
    raw: string,
    allowed: Record<string, (FilterOperator | FilterSuffix | FilterQuantifier)[] | true>,
    kinds: Record<string, string> = {}
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
    if (token.quantifier !== FilterQuantifier.ANY) {
        throw new BadRequestException('Relation quantifiers are not supported')
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
            value = { $ilike: `%${rawValue}%` }
            break
        case FilterOperator.SW:
            value = { $ilike: `${rawValue}%` }
            break
        case FilterOperator.CONTAINS:
            value = { $contains: rawValue.split(',').map(convert) }
            break
    }
    if (token.suffix && token.operator !== FilterOperator.NULL) value = { $not: value }
    return columnCondition(column, value) as FilterQuery<T>
}

export function expressionCondition<T>(
    input: string,
    allowed: Record<string, (FilterOperator | FilterSuffix | FilterQuantifier)[] | true>,
    kinds: Record<string, string>,
    maxComplexity: number
): FilterQuery<T> {
    const tree = normalizeFilterExpression(parseFilterExpression(input, maxComplexity))
    const visit = (node: NormalizedFilterExpression): FilterQuery<T> => {
        if (node.type === 'leaf') {
            const condition = filterCondition<T>(node.column, node.value, allowed, kinds)
            return node.negated ? ({ $not: condition } as FilterQuery<T>) : condition
        }
        return { [node.type === 'and' ? '$and' : '$or']: node.children.map(visit) } as FilterQuery<T>
    }
    return visit(tree)
}
