import { EntitySchema } from '@mikro-orm/core'
import { MikroORM } from '@mikro-orm/sqlite'
import { paginate, PaginationType } from './paginate'

class Article {
    id!: number
    deletedAt?: Date | null
}

const ArticleSchema = new EntitySchema<Article>({
    class: Article,
    properties: {
        id: { type: 'number', primary: true },
        deletedAt: { type: 'Date', nullable: true },
    },
})

describe('named soft-delete filter', () => {
    let orm: any

    beforeAll(async () => {
        orm = await MikroORM.init({
            dbName: ':memory:',
            entities: [ArticleSchema],
            allowGlobalContext: true,
        })
        if (orm.schema?.create) await orm.schema.create()
        else await orm.getSchemaGenerator().createSchema()
        if (orm.em.addFilter.length >= 2) {
            orm.em.addFilter('softDelete', { deletedAt: null }, Article, true)
        } else {
            orm.em.addFilter({ name: 'softDelete', cond: { deletedAt: null }, entity: Article, default: true })
        }
        orm.em.create(Article, { id: 1, deletedAt: null })
        orm.em.create(Article, { id: 2, deletedAt: new Date('2026-01-01') })
        await orm.em.flush()
        orm.em.clear()
    })

    afterAll(async () => {
        await orm.close()
    })

    it('keeps deleted rows hidden by default and includes them on request', async () => {
        const config = {
            sortableColumns: ['id'] as (keyof Article)[],
            allowWithDeletedInQuery: true,
            softDeleteFilter: 'softDelete',
        }
        const repo = orm.em.getRepository(Article)
        const ordinary = await paginate<Article>({ path: 'http://localhost/articles' }, repo, config)
        const withDeleted = await paginate<Article>(
            { withDeleted: true, path: 'http://localhost/articles' },
            repo,
            config
        )
        expect(ordinary.data.map((item) => item.id)).toEqual([1])
        expect(withDeleted.data.map((item) => item.id)).toEqual([1, 2])
        expect(withDeleted.links.current).toContain('withDeleted=true')
    })

    it('applies the soft-delete filter to cursor pages', async () => {
        const result = await paginate<Article>(
            { withDeleted: true, limit: 1, path: 'http://localhost/articles' },
            orm.em.getRepository(Article),
            {
                sortableColumns: ['id'],
                paginationType: PaginationType.CURSOR,
                allowWithDeletedInQuery: true,
                softDeleteFilter: 'softDelete',
            }
        )
        expect(result.data.map((item) => item.id)).toEqual([1])
        expect(result.links.next).toContain('withDeleted=true')
    })

    it('keeps soft-delete behavior when a query builder is supplied', async () => {
        const repo = orm.em.getRepository(Article)
        const config = { sortableColumns: ['id'] as (keyof Article)[], softDeleteFilter: 'softDelete' }
        const ordinary = await paginate<Article>(
            { path: 'http://localhost/articles' },
            repo.createQueryBuilder('a'),
            config
        )
        const withDeleted = await paginate<Article>(
            { path: 'http://localhost/articles' },
            repo.createQueryBuilder('a'),
            { ...config, withDeleted: true }
        )
        expect(ordinary.data.map((item) => item.id)).toEqual([1])
        expect(withDeleted.data.map((item) => item.id)).toEqual([1, 2])
    })

    it('applies soft-delete filters to a custom count query', async () => {
        const repo = orm.em.getRepository(Article)
        const config = {
            sortableColumns: ['id'] as (keyof Article)[],
            softDeleteFilter: 'softDelete',
            buildCountQuery: (queryBuilder: any) => queryBuilder,
        }
        const ordinary = await paginate<Article>({ path: 'http://localhost/articles' }, repo, config)
        const withDeleted = await paginate<Article>({ path: 'http://localhost/articles' }, repo, {
            ...config,
            withDeleted: true,
        })
        expect(ordinary.data.map((item) => item.id)).toEqual([1])
        expect(ordinary.meta.totalItems).toBe(1)
        expect(withDeleted.data.map((item) => item.id)).toEqual([1, 2])
        expect(withDeleted.meta.totalItems).toBe(2)
    })
})
