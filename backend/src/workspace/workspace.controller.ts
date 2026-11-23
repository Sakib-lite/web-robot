import { Body, Controller, ForbiddenException, Get, HttpException, HttpStatus, Injectable, Param, Post } from '@nestjs/common';
import { WorkspaceError } from './workspace.types';
import { WorkspaceService } from './workspace.service';
import { FsAppendDto, FsEditDto, FsListDto, FsPathDto, FsReadDto, FsWriteDto } from './dto/fs.dto';
import { ExecDto } from './dto/exec.dto';
import { WorkspaceControlDto } from './dto/workspace-control.dto';

const STATUS_BY_CODE: Record<string, HttpStatus> = {
  ESCAPE: HttpStatus.FORBIDDEN,
  DENIED: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  EXISTS: HttpStatus.CONFLICT,
  NO_MATCH: HttpStatus.BAD_REQUEST,
  AMBIGUOUS: HttpStatus.BAD_REQUEST,
  TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  INVALID: HttpStatus.BAD_REQUEST,
};

export function workspaceFailure(error: unknown): never {
  if (error instanceof WorkspaceError) {
    throw new HttpException({ code: error.code, message: error.message }, STATUS_BY_CODE[error.code] ?? HttpStatus.BAD_REQUEST);
  }
  throw error;
}

@Injectable()
@Controller()
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get('workspace/status')
  status() {
    return { enabled: this.workspace.isEnabled(), root: this.workspace.workspaceRoot() };
  }

  @Post('workspace/control')
  control(@Body() body: WorkspaceControlDto) {
    if (typeof body.enabled !== 'boolean') throw new HttpException('enabled (boolean) is required', HttpStatus.BAD_REQUEST);
    this.workspace.setEnabled(body.enabled);
    return { enabled: body.enabled };
  }

  @Get('skills')
  async skills() {
    return { skills: await this.workspace.listSkills() };
  }

  @Get('skills/:slug')
  async skill(@Param('slug') slug: string) {
    try {
      return await this.workspace.getSkill(slug);
    } catch (error) {
      workspaceFailure(error);
    }
  }

  @Get('contexts')
  async contexts() {
    return { contexts: await this.workspace.listContexts() };
  }

  @Get('contexts/:slug')
  async context(@Param('slug') slug: string) {
    try {
      return await this.workspace.getContext(slug);
    } catch (error) {
      workspaceFailure(error);
    }
  }

  @Post('fs/list')
  async list(@Body() body: FsListDto) {
    return this.guarded(() => this.workspace.list(body.path ?? '.'));
  }

  @Post('fs/read')
  async read(@Body() body: FsReadDto) {
    return this.guarded(() => this.workspace.read(body.path, body.offset ?? 1, body.limit ?? 300));
  }

  @Post('fs/write')
  async write(@Body() body: FsWriteDto) {
    return this.guarded(() => this.workspace.write(body.path, body.content ?? '', body.onlyIfNew === true, body.encoding));
  }

  @Post('fs/edit')
  async edit(@Body() body: FsEditDto) {
    return this.guarded(() => this.workspace.edit(body.path, body.oldString, body.newString, body.replaceAll === true));
  }

  @Post('fs/append')
  async append(@Body() body: FsAppendDto) {
    return this.guarded(() => this.workspace.append(body.path, body.text ?? ''));
  }

  @Post('fs/delete')
  async delete(@Body() body: FsPathDto) {
    return this.guarded(() => this.workspace.delete(body.path));
  }

  @Post('fs/mkdir')
  async mkdir(@Body() body: FsPathDto) {
    return this.guarded(() => this.workspace.mkdir(body.path));
  }

  @Post('exec')
  async exec(@Body() body: ExecDto) {
    return this.guarded(() => this.workspace.exec(body.cmd, body.timeoutMs, body.cwd));
  }

  private async guarded<T>(run: () => Promise<T>): Promise<T> {
    if (!this.workspace.isEnabled()) {
      throw new ForbiddenException('workspace tools are disabled (POST /workspace/control {"enabled":true} to re-enable)');
    }
    try {
      return await run();
    } catch (error) {
      workspaceFailure(error);
    }
  }
}
