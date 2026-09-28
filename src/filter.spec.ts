import { BadRequestException } from '@nestjs/common'
import {
    expressionCondition,
    filterCondition,
    FilterOperator,
    FilterQuantifier,
    FilterSuffix,
    parseFilterToken,
} from './filter'

describe('MikroORM filter translation', () => {
    it.each([
        ['12', { column: { $eq: 12 } }],
        ['$gt:12', { column: { $gt: 12 } }],
        ['$gte:12', { column: { $gte: 12 } }],
        ['$lt:12', { column: { $lt: 12 } }],
        ['$lte:12', { column: { $lte: 12 } }],
        ['$in:1,2', { column: { $in: [1, 2] } }],
        ['$btw:1,2', { column: { $gte: 1, $lte: 2 } }],
    ])('translates numeric value %s', (raw, expected) => {
        expect(filterCondition('column', raw, { column: true }, { column: 'number' })).toEqual(expected)
    })

    it.each([
        ['$null', { column: null }],
        ['$not:$null', { column: { $ne: null } }],
        ['$ilike:abc', { column: { $ilike: '%abc%' } }],
        ['$sw:abc', { column: { $ilike: 'abc%' } }],
        ['$contains:a,b', { column: { $contains: ['a', 'b'] } }],
        ['$not:$eq:a', { column: { $not: { $eq: 'a' } } }],
    ])('translates operator %s', (raw, expected) => {
        expect(filterCondition('column', raw, { column: true })).toEqual(expected)
    })

    it('nests a dotted relation path', () => {
        expect(filterCondition('licenses.country', 'FR', { 'licenses.country': true })).toEqual({
            licenses: { country: { $eq: 'FR' } },
        })
    })

    it('converts booleans and dates', () => {
        expect(filterCondition('active', 'true', { active: true }, { active: 'boolean' })).toEqual({
            active: { $eq: true },
        })
        expect(filterCondition('createdAt', '2026-01-01', { createdAt: true }, { createdAt: 'date' })).toEqual({
            createdAt: { $eq: new Date('2026-01-01') },
        })
    })

    it.each([
        ['missing', 'value', { column: true }, {}],
        ['column', '$gt:1', { column: [FilterOperator.EQ] }, {}],
        ['column', '$not:$eq:a', { column: [FilterOperator.EQ] }, {}],
        ['column', '$all:$eq:a', { column: [FilterQuantifier.ALL] }, {}],
        ['column', '$btw:1', { column: true }, { column: 'number' }],
        ['column', 'NaN', { column: true }, { column: 'number' }],
        ['column', 'yes', { column: true }, { column: 'boolean' }],
        ['column', 'not-a-date', { column: true }, { column: 'date' }],
    ])('rejects invalid filter %s=%s', (column, raw, allowed, kinds) => {
        expect(() => filterCondition(column, raw, allowed as Parameters<typeof filterCondition>[2], kinds)).toThrow(
            BadRequestException
        )
    })

    it('accepts explicitly allow-listed negation', () => {
        expect(filterCondition('column', '$not:$eq:a', { column: [FilterOperator.EQ, FilterSuffix.NOT] })).toEqual({
            column: { $not: { $eq: 'a' } },
        })
    })

    it('preserves colons in literal values', () => {
        expect(parseFilterToken('$eq:2026-01-01T10:30:00Z')?.value).toBe('2026-01-01T10:30:00Z')
    })

    it('converts boolean expressions to nested filter queries', () => {
        expect(expressionCondition('status=$eq:pending OR status=$eq:verified', { status: true }, {}, 20)).toEqual({
            $or: [{ status: { $eq: 'pending' } }, { status: { $eq: 'verified' } }],
        })
    })
})
