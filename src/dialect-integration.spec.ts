import { EntitySchema } from '@mikro-orm/core'
import { MikroORM as PostgreSqlORM } from '@mikro-orm/postgresql'
import { MikroORM as MySqlORM } from '@mikro-orm/mysql'
import { FilterOperator, paginate, type PaginateConfig } from './paginate'

class DialectArticle {
    id!: number
    title!: string
    nickname?: string | null
    details!: { label: string }
    normalizedTitle?: string
    parent?: DialectArticle | null
}

const ArticleSchema = new EntitySchema<DialectArticle>({
    class: DialectArticle,
    properties: {
        id: { type: 'number', primary: true },
        title: { type: 'string' },
        nickname: { type: 'string', nullable: true },
        details: { type: 'json' },
        normalizedTitle: { type: 'string', formula: (alias: any) => `lower(${alias}.title)` },
        parent: { kind: 'm:1', entity: () => DialectArticle, nullable: true },
    },
})

for (const [name, url, driver] of [
    ['PostgreSQL', process.env.PAGINATE_TEST_POSTGRES_URL, PostgreSqlORM],
    ['MariaDB', process.env.PAGINATE_TEST_MARIADB_URL, MySqlORM],
] as const) {
    describe.skipIf(!url)(`${name} dialect integration`, () => {
        let orm: any

        beforeAll(async () => {
            orm = await driver.init({ clientUrl: url!, entities: [ArticleSchema], allowGlobalContext: true })
            if (orm.schema?.refresh) await orm.schema.refresh()
            else await orm.getSchemaGenerator().refreshDatabase()
            const parent = orm.em.create(DialectArticle, {
                id: 1,
                title: 'Alpha',
                nickname: null,
                details: { label: 'z' },
            })
            orm.em.create(DialectArticle, {
                id: 2,
                title: 'beta',
                nickname: 'Bee',
                details: { label: 'a' },
                parent,
            })
            await orm.em.flush()
            orm.em.clear()
        })

        afterAll(async () => {
            await orm?.close()
        })

        const config: PaginateConfig<DialectArticle> = {
            sortableColumns: ['id', 'nickname', 'details.label', 'normalizedTitle', 'parent.details.label'],
            searchableColumns: ['title'],
            filterableColumns: {
                'details.label': true,
                'parent.details.label': true,
                title: [FilterOperator.ILIKE],
                normalizedTitle: true,
            },
        }

        it('handles search, JSON paths, NULL order and formula fields', async () => {
            const repository = orm.em.getRepository(DialectArticle)
            const path = 'http://localhost/articles'
            const searched = await paginate({ search: 'ALPHA', path }, repository, config)
            expect(searched.data.map((row) => row.id)).toEqual([1])

            const filtered = await paginate({ filter: { 'details.label': 'a' }, path }, repository, config)
            expect(filtered.data.map((row) => row.id)).toEqual([2])

            const textFiltered = await paginate({ filter: { title: '$ilike:ALPHA' }, path }, repository, config)
            expect(textFiltered.data.map((row) => row.id)).toEqual([1])

            const jsonSorted = await paginate({ sortBy: [['details.label', 'ASC']], path }, repository, config)
            expect(jsonSorted.data.map((row) => row.id)).toEqual([2, 1])

            const nullSorted = await paginate({ sortBy: [['nickname', 'ASC']], path }, repository, {
                ...config,
                nullSort: 'first',
            })
            expect(nullSorted.data.map((row) => row.id)).toEqual([1, 2])

            const formulaFiltered = await paginate({ filter: { normalizedTitle: 'alpha' }, path }, repository, config)
            expect(formulaFiltered.data.map((row) => row.id)).toEqual([1])

            const formulaSorted = await paginate({ sortBy: [['normalizedTitle', 'DESC']], path }, repository, config)
            expect(formulaSorted.data.map((row) => row.id)).toEqual([2, 1])

            const relationJsonFiltered = await paginate(
                { filter: { 'parent.details.label': 'z' }, path },
                repository,
                config
            )
            expect(relationJsonFiltered.data.map((row) => row.id)).toEqual([2])

            const relationJsonSorted = await paginate({ sortBy: [['parent.details.label', 'ASC']], path }, repository, {
                ...config,
                nullSort: 'last',
            })
            expect(relationJsonSorted.data.map((row) => row.id)).toEqual([2, 1])
        })
    })
}
