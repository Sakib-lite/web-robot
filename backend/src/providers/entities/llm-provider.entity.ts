import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('llm_providers')
export class LlmProvider {
  @PrimaryColumn()
  product!: string;

  @Column({ type: 'text', name: 'api_key', nullable: true })
  apiKey!: string | null;

  @Column({ type: 'text', name: 'base_url', nullable: true })
  baseUrl!: string | null;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @Column({ type: 'text', nullable: true })
  effort!: string | null;

  @Column({ default: false })
  active!: boolean;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
