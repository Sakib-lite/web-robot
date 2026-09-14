import { Body, Controller, ForbiddenException, Get, HttpException, HttpStatus, Injectable, Param, Post } from '@nestjs/common';
import { WorkspaceError, WorkspaceService } from './workspace.service';

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

// maps WorkspaceError to an http status and keeps the machine-readable code in
// the body so the extension can branch on it (e.g. EXISTS → "read first")
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
  control(@Body() body: { enabled: boolean }) {
    if (typeof body.enabled !== 'boolean') throw new HttpException('enabled (boolean) is required', HttpStatus.BAD_REQUEST);
    this.workspace.setEnabled(body.enabled);
    return { enabled: body.enabled };
  }

  // read-only skill metadata: usable even when workspace tools are disabled
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

  @Post('fs/list')
  async list(@Body() body: { path?: string }) {
    return this.guarded(() => this.workspace.list(body.path ?? '.'));
  }

  @Post('fs/read')
  async read(@Body() body: { path: string; offset?: number; limit?: number }) {
    return this.guarded(() => this.workspace.read(body.path, body.offset ?? 1, body.limit ?? 300));
  }

  @Post('fs/write')
  async write(@Body() body: { path: string; content: string; onlyIfNew?: boolean }) {
    return this.guarded(() => this.workspace.write(body.path, body.content ?? '', body.onlyIfNew === true));
  }

  @Post('fs/edit')
  async edit(@Body() body: { path: string; oldString: string; newString: string; replaceAll?: boolean }) {
    return this.guarded(() => this.workspace.edit(body.path, body.oldString, body.newString, body.replaceAll === true));
  }

  @Post('fs/append')
  async append(@Body() body: { path: string; text: string }) {
    return this.guarded(() => this.workspace.append(body.path, body.text ?? ''));
  }

  @Post('fs/delete')
  async delete(@Body() body: { path: string }) {
    return this.guarded(() => this.workspace.delete(body.path));
  }

  @Post('fs/mkdir')
  async mkdir(@Body() body: { path: string }) {
    return this.guarded(() => this.workspace.mkdir(body.path));
  }

  @Post('exec')
  async exec(@Body() body: { cmd: string; timeoutMs?: number }) {
    return this.guarded(() => this.workspace.exec(body.cmd, body.timeoutMs));
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
