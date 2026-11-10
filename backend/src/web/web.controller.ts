import { Body, Controller, HttpException, HttpStatus, Injectable, Post } from '@nestjs/common';
import { WebError, WebService } from './web.service';
import { WebFetchDto, WebSearchDto } from './dto/web.dto';

const STATUS_BY_CODE: Record<string, HttpStatus> = {
  INVALID: HttpStatus.BAD_REQUEST,
  FETCH_FAILED: HttpStatus.BAD_GATEWAY,
  NOT_TEXT: HttpStatus.UNPROCESSABLE_ENTITY,
  SEARCH_FAILED: HttpStatus.BAD_GATEWAY,
};

export function webFailure(error: unknown): never {
  if (error instanceof WebError) {
    throw new HttpException({ code: error.code, message: error.message }, STATUS_BY_CODE[error.code] ?? HttpStatus.BAD_REQUEST);
  }
  throw error;
}

@Injectable()
@Controller('web')
export class WebController {
  constructor(private readonly web: WebService) {}

  @Post('fetch')
  async fetch(@Body() body: WebFetchDto) {
    try {
      return await this.web.fetchUrl(String(body.url ?? ''));
    } catch (error) {
      webFailure(error);
    }
  }

  @Post('search')
  async search(@Body() body: WebSearchDto) {
    try {
      return await this.web.search(String(body.query ?? ''), body.limit && body.limit > 0 ? Math.min(body.limit, 10) : 8);
    } catch (error) {
      webFailure(error);
    }
  }
}
