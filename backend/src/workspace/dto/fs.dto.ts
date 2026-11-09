export class FsListDto {
  path?: string;
}

export class FsReadDto {
  path!: string;
  offset?: number;
  limit?: number;
}

export class FsWriteDto {
  path!: string;
  content!: string;
  onlyIfNew?: boolean;
  encoding?: 'base64';
}

export class FsEditDto {
  path!: string;
  oldString!: string;
  newString!: string;
  replaceAll?: boolean;
}

export class FsAppendDto {
  path!: string;
  text!: string;
}

export class FsPathDto {
  path!: string;
}
