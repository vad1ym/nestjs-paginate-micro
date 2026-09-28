import { Controller, Get, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ApiProperty, SwaggerModule } from '@nestjs/swagger'
import { Paginate, PaginateQuery } from '../decorator'
import type { PaginateConfig } from '../paginate'
import { PaginatedSwaggerDocs } from './api-paginated-swagger-docs.decorator'

class DoctorDto {
    @ApiProperty()
    id!: number
}

const config: PaginateConfig<DoctorDto> = {
    sortableColumns: ['id'],
    searchableColumns: ['firstName'],
    filterableColumns: { verificationStatus: true },
}

@Controller('doctors')
class DoctorsController {
    @Get()
    @PaginatedSwaggerDocs(DoctorDto, config)
    findAll(@Paginate() _query: PaginateQuery) {
        return { data: [], meta: {}, links: {} }
    }
}

@Module({ controllers: [DoctorsController] })
class DoctorsModule {}

it('documents the retained query and response shape in NestJS 12', async () => {
    const module = await Test.createTestingModule({ imports: [DoctorsModule] }).compile()
    const app = module.createNestApplication()
    await app.init()
    try {
        const document = SwaggerModule.createDocument(app, {
            openapi: '3.0.0',
            info: { title: 'Pagination', version: '1' },
        })
        const operation = document.paths['/doctors'].get!
        expect(operation.parameters).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'page' }),
                expect.objectContaining({ name: 'sortBy' }),
                expect.objectContaining({ name: 'filter.verificationStatus' }),
            ])
        )
        expect(operation.responses?.['200']).toBeDefined()
    } finally {
        await app.close()
    }
})
