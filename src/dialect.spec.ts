import { BadRequestException } from '@nestjs/common'
import { dialectFor, MySqlDialect, PostgreSqlDialect, SqliteDialect } from './dialect'

describe('SQL dialect adapters', () => {
    it.each([
        ['PostgreSqlPlatform', PostgreSqlDialect],
        ['CockroachDbPlatform', PostgreSqlDialect],
        ['MySqlPlatform', MySqlDialect],
        ['MariaDbPlatform', MySqlDialect],
        ['SqlitePlatform', SqliteDialect],
    ])('maps %s', (name, type) => {
        expect(dialectFor(name)).toBeInstanceOf(type)
    })

    it('rejects an unsupported database', () => {
        expect(() => dialectFor('MongoPlatform')).toThrow(BadRequestException)
    })

    it('uses dialect-specific JSON extraction', () => {
        expect(dialectFor('PostgreSqlPlatform').jsonScalar('doc', ['ui', 'color'])).toBe("doc->'ui'->>'color'")
        expect(dialectFor('MySqlPlatform').jsonScalar('doc', ['ui', 'color'])).toBe(
            `JSON_UNQUOTE(JSON_EXTRACT(doc, '$."ui"."color"'))`
        )
        expect(dialectFor('SqlitePlatform').jsonScalar('doc', ['ui', 'color'])).toBe(
            `json_extract(doc, '$."ui"."color"')`
        )
    })

    it('escapes JSON path literals', () => {
        expect(dialectFor('PostgreSqlPlatform').jsonScalar('doc', ["o'hare"])).toBe("doc->>'o''hare'")
    })
})
