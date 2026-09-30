import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { UpsertProviderDto } from './dto/upsert-provider.dto';

@Controller()
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get('providers')
  async list() {
    return { providers: await this.providers.list() };
  }

  @Get('providers/active')
  active() {
    return this.providers.getActive();
  }

  @Put('providers/:product')
  upsert(@Param('product') product: string, @Body() body: UpsertProviderDto) {
    const fields = Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => typeof v === 'string' && v.trim() !== ''));
    return this.providers.upsert(product, fields);
  }

  @Post('providers/:product/activate')
  activate(@Param('product') product: string) {
    return this.providers.activate(product);
  }
}
