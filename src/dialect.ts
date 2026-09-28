import { BadRequestException } from '@nestjs/common'

/** SQL differences are contained here; pagination and filter planning stay database-neutral. */
export abstract class SqlDialect {
    abstract readonly name: string
    abstract readonly caseInsensitiveOperator: '$ilike' | '$like'

    abstract jsonScalar(column: string, path: readonly string[]): string

    coalesce(columns: readonly string[]): string {
        return `COALESCE(${columns.join(', ')})`
    }

    nullSort(column: string, direction: 'ASC' | 'DESC', placement: 'first' | 'last'): [string, string][] {
        return [[column, `${direction} NULLS ${placement.toUpperCase()}`]]
    }

    protected quoteLiteral(value: string): string {
        return `'${value.replace(/'/g, "''")}'`
    }
}

export class PostgreSqlDialect extends SqlDialect {
    readonly name = 'postgresql'
    readonly caseInsensitiveOperator = '$ilike'

    jsonScalar(column: string, path: readonly string[]): string {
        return path.reduce(
            (sql, part, index) => `${sql}${index === path.length - 1 ? '->>' : '->'}${this.quoteLiteral(part)}`,
            column
        )
    }
}

export class MySqlDialect extends SqlDialect {
    readonly name = 'mysql'
    readonly caseInsensitiveOperator = '$like'

    jsonScalar(column: string, path: readonly string[]): string {
        const jsonPath = '$' + path.map((part) => `.${JSON.stringify(part)}`).join('')
        return `JSON_UNQUOTE(JSON_EXTRACT(${column}, ${this.quoteLiteral(jsonPath)}))`
    }

    override nullSort(column: string, direction: 'ASC' | 'DESC', placement: 'first' | 'last'): [string, string][] {
        return [
            [`(${column} IS NULL)`, placement === 'first' ? 'DESC' : 'ASC'],
            [column, direction],
        ]
    }
}

export class SqliteDialect extends SqlDialect {
    readonly name = 'sqlite'
    readonly caseInsensitiveOperator = '$like'

    jsonScalar(column: string, path: readonly string[]): string {
        const jsonPath = '$' + path.map((part) => `.${JSON.stringify(part)}`).join('')
        return `json_extract(${column}, ${this.quoteLiteral(jsonPath)})`
    }
}

/** Recognize only SQL drivers whose SQL differences are implemented and tested. */
export function dialectFor(platformName: string): SqlDialect {
    if (/Postgre|Cockroach/i.test(platformName)) return new PostgreSqlDialect()
    if (/Maria|MySql/i.test(platformName)) return new MySqlDialect()
    if (/Sqlite/i.test(platformName)) return new SqliteDialect()
    throw new BadRequestException(`Unsupported MikroORM SQL platform: ${platformName}`)
}
