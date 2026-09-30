import { EntitySchema } from '@mikro-orm/core'
import { Embeddable, Embedded, Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy'
import { MikroORM as PostgreSqlORM } from '@mikro-orm/postgresql'
import { MikroORM as MySqlORM } from '@mikro-orm/mysql'
import { FilterOperator, paginate, type PaginateConfig } from './paginate'

@Embeddable()
class LocalizedValue {
    @Property({ type: 'string', nullable: true })
    en: string | null = null

    @Property({ type: 'string', nullable: true })
    es: string | null = null
}

@Entity({ tableName: 'localized_pagination_records' })
class LocalizedRecord {
    @PrimaryKey({ type: 'number' })
    id!: number

    @Embedded(() => LocalizedValue, { object: true })
    title = new LocalizedValue()
}

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

const postgresUrl = process.env.PAGINATE_TEST_POSTGRES_URL
it('discovers localized entity metadata without a database connection', async () => {
    const orm = await PostgreSqlORM.init({
        dbName: 'paginate_metadata_test',
        entities: [LocalizedRecord],
    })
    try {
        expect(orm.getMetadata().get(LocalizedRecord).properties.title.targetMeta!.properties.en.type).toBe('string')
    } finally {
        await orm.close()
    }
})

describe.skipIf(!postgresUrl)('PostgreSQL localized field resolvers', () => {
    let orm: any

    beforeAll(async () => {
        orm = await PostgreSqlORM.init({
            clientUrl: postgresUrl!,
            schema: `paginate_localized_${process.pid}`,
            entities: [LocalizedRecord],
            allowGlobalContext: true,
        })
        if (orm.schema?.create) await orm.schema.create()
        else await orm.getSchemaGenerator().createSchema()

        orm.em.create(LocalizedRecord, { title: { en: 'Alpha', es: 'Consulta breve' } })
        orm.em.create(LocalizedRecord, { title: { en: 'Beta', es: '' } })
        orm.em.create(LocalizedRecord, { title: { en: 'Gamma', es: '   ' } })
        await orm.em.flush()
        orm.em.clear()
    })

    afterAll(async () => {
        if (orm) {
            if (orm.schema?.drop) await orm.schema.drop()
            else await orm.getSchemaGenerator().dropSchema()
            await orm.close()
        }
    })

    it('uses locale fallback for sorting and filters, and searches every locale', async () => {
        type LocaleContext = { locale: 'en' | 'es' }
        const config = {
            sortableColumns: ['title'],
            searchableColumns: ['title'],
            filterableColumns: { title: ['$eq', '$ilike', '$sw', '$null'] },
            defaultSortBy: [['title', 'ASC']],
            fieldResolvers: {
                title: {
                    sort: (entity, context) => entity.title.get(context.locale),
                    search: (entity) => entity.title.all(),
                    filter: (entity, context) => entity.title.get(context.locale),
                },
            },
        } satisfies PaginateConfig<LocalizedRecord, LocaleContext>
        const repository = orm.em.getRepository(LocalizedRecord)
        const path = 'http://localhost/localized-records'

        const sorted = await paginate({ path }, repository, config, { locale: 'es' })
        expect(sorted.data.map((row) => row.id)).toEqual([2, 3, 1])

        const searched = await paginate({ path, search: 'Consulta' }, repository, config, { locale: 'es' })
        expect(searched.data.map((row) => row.id)).toEqual([1])

        const filtered = await paginate({ path, filter: { title: '$ilike:Bet' } }, repository, config, { locale: 'es' })
        expect(filtered.data.map((row) => row.id)).toEqual([2])
    })

    it('rejects unsupported locales and cursor sorting through computed fields', async () => {
        const config: PaginateConfig<LocalizedRecord, { locale: string }> = {
            sortableColumns: ['title'],
            defaultSortBy: [['title', 'ASC']],
            fieldResolvers: {
                title: (entity, context) => entity.title.get(context.locale),
            },
        }
        const repository = orm.em.getRepository(LocalizedRecord)

        await expect(paginate({ path: null }, repository, config, { locale: 'xx' })).rejects.toThrow(
            'Unknown localized field or locale'
        )
        await expect(
            paginate(
                { path: null, limit: 10 },
                repository,
                {
                    ...config,
                    paginationType: 'cursor' as any,
                },
                { locale: 'en' }
            )
        ).rejects.toThrow('Field resolver sorting requires offset pagination')
    })
})
