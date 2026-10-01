import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { LlmProvider } from './entities/llm-provider.entity';

@Injectable()
export class ProvidersService {
  constructor(
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    private readonly dataSource: DataSource,
  ) {}

  async list(): Promise<LlmProvider[]> {
    return this.providers.find({ order: { active: 'DESC', product: 'ASC' } });
  }

  async getActive(): Promise<LlmProvider> {
    const row = await this.providers.findOneBy({ active: true });
    if (!row) throw new NotFoundException('no active llm provider');
    return row;
  }

  async upsert(product: string, fields: { apiKey?: string; baseUrl?: string; model?: string; effort?: string }): Promise<LlmProvider> {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(product)) throw new NotFoundException(`bad product "${product}"`);
    const existing = await this.providers.findOneBy({ product });
    const saved = await this.providers.save({
      ...(existing ?? { product, active: false }),
      product,
      apiKey: fields.apiKey ?? existing?.apiKey ?? null,
      baseUrl: fields.baseUrl ?? existing?.baseUrl ?? null,
      model: fields.model ?? existing?.model ?? null,
      effort: fields.effort ?? existing?.effort ?? null,
    });
    return saved;
  }

  async activate(product: string): Promise<LlmProvider> {
    return this.dataSource.transaction(async (em) => {
      const row = await em.findOne(LlmProvider, { where: { product } });
      if (!row) throw new NotFoundException(`product "${product}" is not configured`);
      await em.update(LlmProvider, { active: true }, { active: false });
      await em.update(LlmProvider, { product }, { active: true });
      return row;
    });
  }
}
