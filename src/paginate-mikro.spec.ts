import { Collection, EntitySchema } from '@mikro-orm/core'
import { MikroORM } from '@mikro-orm/sqlite'
import type { EntityRepository, SelectQueryBuilder } from '@mikro-orm/postgresql'
import { FilterOperator, paginate, PaginateConfig, PaginationType } from './paginate'

class Doctor {
    id!: number
    firstName!: string
    lastName!: string
    verificationStatus!: string
    createdAt!: Date
    licenses = new Collection<License>(this)
}

class License {
    id!: number
    doctor!: Doctor
    country!: string
}

const DoctorSchema = new EntitySchema<Doctor>({
    class: Doctor,
    properties: {
        id: { type: 'number', primary: true },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        verificationStatus: { type: 'string' },
        createdAt: { type: 'Date' },
        licenses: { kind: '1:m', entity: () => License, mappedBy: 'doctor' },
    },
})
const LicenseSchema = new EntitySchema<License>({
    class: License,
    properties: {
        id: { type: 'number', primary: true },
        doctor: { kind: 'm:1', entity: () => Doctor },
        country: { type: 'string' },
    },
})

const config: PaginateConfig<Doctor> = {
    sortableColumns: ['createdAt', 'lastName', 'id'],
    searchableColumns: ['firstName', 'lastName'],
    filterableColumns: {
        verificationStatus: [FilterOperator.EQ, FilterOperator.IN],
        id: [FilterOperator.GT],
    },
    defaultSortBy: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
    ],
}

describe('MikroORM pagination', () => {
    let orm: any

    beforeAll(async () => {
        orm = await MikroORM.init({
            dbName: ':memory:',
            entities: [DoctorSchema, LicenseSchema],
            allowGlobalContext: true,
        })
        if (orm.schema?.create) await orm.schema.create()
        else await orm.getSchemaGenerator().createSchema()
        const rows = [
            [1, 'Alice', 'Adams', 'pending'],
            [2, 'Bob', 'Brown', 'verified'],
            [3, 'Alice', 'Clark', 'pending'],
            [4, 'Diana', 'Dover', 'rejected'],
        ] as const
        const doctors: Doctor[] = []
        for (const [id, firstName, lastName, verificationStatus] of rows) {
            doctors.push(
                orm.em.create(Doctor, {
                    id,
                    firstName,
                    lastName,
                    verificationStatus,
                    createdAt: new Date(`2026-01-0${id}`),
                })
            )
        }
        orm.em.create(License, { id: 1, doctor: doctors[3], country: 'ES' })
        orm.em.create(License, { id: 2, doctor: doctors[3], country: 'FR' })
        await orm.em.flush()
        orm.em.clear()
    })

    afterAll(async () => {
        await orm.close()
    })

    it('keeps offset totals, filters and links', async () => {
        const result = await paginate<Doctor>(
            {
                page: 1,
                limit: 1,
                search: 'Alice',
                filter: { verificationStatus: 'pending' },
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.data.map((row) => row.id)).toEqual([3])
        expect(result.meta.totalItems).toBe(2)
        expect(result.meta.totalPages).toBe(2)
        expect(result.links.next).toContain('page=2')
        expect(result.links.next).toContain('filter.verificationStatus=pending')
    })

    it('supports filter expressions and rejects disallowed fields', async () => {
        const result = await paginate<Doctor>(
            {
                filterExpression: 'verificationStatus=$eq:pending OR verificationStatus=$eq:verified',
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.meta.totalItems).toBe(3)
        expect(result.links.current).toContain('filter=')
        await expect(
            paginate(
                {
                    filterExpression: 'firstName=$eq:Alice',
                    path: 'http://localhost/admin/doctors',
                },
                orm.em.getRepository(Doctor),
                config
            )
        ).rejects.toThrow()
    })

    it('supports MikroORM cursor pages', async () => {
        const result = await paginate<Doctor>(
            {
                limit: 2,
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            { ...config, paginationType: PaginationType.CURSOR }
        )
        expect(result.data).toHaveLength(2)
        expect(result.links.next).toContain('cursor=')
        const cursor = new URL(result.links.next!).searchParams.get('cursor')!
        const second = await paginate<Doctor>(
            {
                limit: 2,
                cursor,
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            { ...config, paginationType: PaginationType.CURSOR }
        )
        expect(second.data.map((row) => row.id)).toEqual([2, 1])
        const previous = new URL(second.links.previous!).searchParams.get('cursor')!
        const firstAgain = await paginate<Doctor>(
            {
                limit: 2,
                cursor: previous,
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            { ...config, paginationType: PaginationType.CURSOR }
        )
        expect(firstAgain.data.map((row) => row.id)).toEqual([4, 3])
    })

    it('converts numeric filter values from entity metadata', async () => {
        const result = await paginate<Doctor>(
            {
                filter: { id: '$gt:2' },
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.data.map((row) => row.id)).toEqual([4, 3])
    })

    it('combines repeated filters with the requested comparator', async () => {
        const result = await paginate<Doctor>(
            {
                filter: { verificationStatus: ['pending', '$or:$eq:verified'] },
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            { ...config, throwOnInvalidFilter: true }
        )
        expect(result.meta.totalItems).toBe(3)
    })

    it('accepts a MikroORM query builder with its own scope', async () => {
        const builder: SelectQueryBuilder<Doctor> = orm.em
            .createQueryBuilder(Doctor, 'doctor')
            .where({ verificationStatus: 'pending' })
        const result = await paginate<Doctor>(
            {
                limit: 1,
                path: 'http://localhost/admin/doctors',
            },
            builder,
            config
        )
        expect(result.meta.totalItems).toBe(2)
        expect(result.data.map((row) => row.id)).toEqual([3])
    })

    it('loads collections without multiplying root page rows or total', async () => {
        const doctors: EntityRepository<Doctor> = orm.em.getRepository(Doctor)
        const result = await paginate<Doctor>(
            {
                limit: 1,
                path: 'http://localhost/admin/doctors',
            },
            doctors,
            { ...config, relations: { licenses: true } }
        )
        expect(result.meta.totalItems).toBe(4)
        expect(result.data).toHaveLength(1)
        expect(result.data[0].licenses.getItems()).toHaveLength(2)
    })

    it.each([
        [1, 2, [4, 3], 2],
        [2, 2, [2, 1], 2],
        [9, 2, [], 2],
    ])('paginates page %i with limit %i', async (page, limit, ids, totalPages) => {
        const result = await paginate<Doctor>(
            { page, limit, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.data.map((row) => row.id)).toEqual(ids)
        expect(result.meta.totalItems).toBe(4)
        expect(result.meta.totalPages).toBe(totalPages)
    })

    it('caps a requested limit to maxLimit', async () => {
        const result = await paginate<Doctor>(
            { limit: 100, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, maxLimit: 2 }
        )
        expect(result.data).toHaveLength(2)
        expect(result.meta.itemsPerPage).toBe(2)
    })

    it('uses a config scope together with caller filters', async () => {
        const result = await paginate<Doctor>(
            { filter: { verificationStatus: 'pending' }, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, where: { firstName: 'Alice' } }
        )
        expect(result.data.map((row) => row.id)).toEqual([3, 1])
        expect(result.meta.totalItems).toBe(2)
    })

    it('ignores disallowed filters by default', async () => {
        const result = await paginate<Doctor>(
            { filter: { firstName: 'Alice' }, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.meta.totalItems).toBe(4)
    })

    it('rejects disallowed filters when strict', async () => {
        await expect(
            paginate<Doctor>(
                { filter: { firstName: 'Alice' }, path: 'http://localhost/admin/doctors' },
                orm.em.getRepository(Doctor),
                { ...config, throwOnInvalidFilter: true }
            )
        ).rejects.toThrow()
    })

    it('uses only allow-listed sorting columns', async () => {
        const result = await paginate<Doctor>(
            { sortBy: [['firstName', 'ASC']], path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.data.map((row) => row.id)).toEqual([4, 3, 2, 1])
        expect(result.meta.sortBy).toEqual(config.defaultSortBy)
    })

    it('preserves an explicit descending sort', async () => {
        const result = await paginate<Doctor>(
            { sortBy: [['lastName', 'DESC']], path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.data.map((row) => row.id)).toEqual([4, 3, 2, 1])
        expect(result.meta.sortBy).toEqual([['lastName', 'DESC']])
    })

    it('rejects TypeORM-only join configuration', async () => {
        await expect(
            paginate<Doctor>({ path: 'http://localhost/admin/doctors' }, orm.em.getRepository(Doctor), {
                ...config,
                defaultJoinMethod: 'innerJoinAndSelect',
            })
        ).rejects.toThrow()
    })

    it('omits links for non-HTTP contexts', async () => {
        const result = await paginate<Doctor>({ limit: 2, path: null }, orm.em.getRepository(Doctor), config)
        expect(result.links).toEqual({})
    })
})
