export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      agent_memories: {
        Row: {
          content: string
          created_at: string
          enabled: boolean
          id: string
          importance: number
          last_used_at: string | null
          memory_type: string
          source_run_id: string | null
          tags: string[]
          title: string
          updated_at: string
          use_count: number
        }
        Insert: {
          content: string
          created_at?: string
          enabled?: boolean
          id?: string
          importance?: number
          last_used_at?: string | null
          memory_type?: string
          source_run_id?: string | null
          tags?: string[]
          title: string
          updated_at?: string
          use_count?: number
        }
        Update: {
          content?: string
          created_at?: string
          enabled?: boolean
          id?: string
          importance?: number
          last_used_at?: string | null
          memory_type?: string
          source_run_id?: string | null
          tags?: string[]
          title?: string
          updated_at?: string
          use_count?: number
        }
        Relationships: []
      }
      agent_runs: {
        Row: {
          automation_mode: string
          chat_settings: Json | null
          completed_at: string | null
          created_at: string
          error: string | null
          events: Json
          id: string
          memory_snapshot: Json
          model: string
          pending_skill: Json | null
          prompt: string
          result: Json | null
          skill_id: string | null
          source: string
          status: string
          task_mode: string
          telegram_chat_id: string | null
          telegram_status_message_id: number | null
          updated_at: string
          workspace_path: string
        }
        Insert: {
          automation_mode?: string
          chat_settings?: Json | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          events?: Json
          id?: string
          memory_snapshot?: Json
          model?: string
          pending_skill?: Json | null
          prompt?: string
          result?: Json | null
          skill_id?: string | null
          source?: string
          status?: string
          task_mode?: string
          telegram_chat_id?: string | null
          telegram_status_message_id?: number | null
          updated_at?: string
          workspace_path?: string
        }
        Update: {
          automation_mode?: string
          chat_settings?: Json | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          events?: Json
          id?: string
          memory_snapshot?: Json
          model?: string
          pending_skill?: Json | null
          prompt?: string
          result?: Json | null
          skill_id?: string | null
          source?: string
          status?: string
          task_mode?: string
          telegram_chat_id?: string | null
          telegram_status_message_id?: number | null
          updated_at?: string
          workspace_path?: string
        }
        Relationships: []
      }
      agent_skills: {
        Row: {
          created_at: string
          description: string
          enabled: boolean
          id: string
          is_routine: boolean
          last_used_at: string | null
          name: string
          routine_cron: string | null
          routine_last_run_at: string | null
          slug: string
          source: string
          source_url: string | null
          steps: Json
          system_prompt: string
          tags: string[]
          triggers: string[]
          updated_at: string
          use_count: number
        }
        Insert: {
          created_at?: string
          description?: string
          enabled?: boolean
          id?: string
          is_routine?: boolean
          last_used_at?: string | null
          name: string
          routine_cron?: string | null
          routine_last_run_at?: string | null
          slug: string
          source?: string
          source_url?: string | null
          steps?: Json
          system_prompt?: string
          tags?: string[]
          triggers?: string[]
          updated_at?: string
          use_count?: number
        }
        Update: {
          created_at?: string
          description?: string
          enabled?: boolean
          id?: string
          is_routine?: boolean
          last_used_at?: string | null
          name?: string
          routine_cron?: string | null
          routine_last_run_at?: string | null
          slug?: string
          source?: string
          source_url?: string | null
          steps?: Json
          system_prompt?: string
          tags?: string[]
          triggers?: string[]
          updated_at?: string
          use_count?: number
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          agent_automation_mode: string
          agent_memory_enabled: boolean
          agent_memory_max_items: number
          agent_shell_enabled: boolean
          agent_task_mode: string
          agent_workspace_path: string
          ai_api_key: string
          ai_base_url: string
          ai_model: string
          ai_provider: string
          created_at: string
          delete_after_upload: boolean
          folder_path: string
          id: number
          image_api_key: string
          image_keys: Json
          image_model: string
          image_provider: string
          image_secondary_key: string
          instagram_email: string
          instagram_enabled: boolean
          instagram_password: string
          local_agent_url: string
          research_api_key: string
          research_depth: string
          research_provider: string
          telegram_bot_token: string
          telegram_chat_id: string
          telegram_enabled: boolean
          tiktok_email: string
          tiktok_enabled: boolean
          tiktok_password: string
          updated_at: string
          upload_mode: string
          youtube_email: string
          youtube_enabled: boolean
          youtube_password: string
        }
        Insert: {
          agent_automation_mode?: string
          agent_memory_enabled?: boolean
          agent_memory_max_items?: number
          agent_shell_enabled?: boolean
          agent_task_mode?: string
          agent_workspace_path?: string
          ai_api_key?: string
          ai_base_url?: string
          ai_model?: string
          ai_provider?: string
          created_at?: string
          delete_after_upload?: boolean
          folder_path?: string
          id?: number
          image_api_key?: string
          image_keys?: Json
          image_model?: string
          image_provider?: string
          image_secondary_key?: string
          instagram_email?: string
          instagram_enabled?: boolean
          instagram_password?: string
          local_agent_url?: string
          research_api_key?: string
          research_depth?: string
          research_provider?: string
          telegram_bot_token?: string
          telegram_chat_id?: string
          telegram_enabled?: boolean
          tiktok_email?: string
          tiktok_enabled?: boolean
          tiktok_password?: string
          updated_at?: string
          upload_mode?: string
          youtube_email?: string
          youtube_enabled?: boolean
          youtube_password?: string
        }
        Update: {
          agent_automation_mode?: string
          agent_memory_enabled?: boolean
          agent_memory_max_items?: number
          agent_shell_enabled?: boolean
          agent_task_mode?: string
          agent_workspace_path?: string
          ai_api_key?: string
          ai_base_url?: string
          ai_model?: string
          ai_provider?: string
          created_at?: string
          delete_after_upload?: boolean
          folder_path?: string
          id?: number
          image_api_key?: string
          image_keys?: Json
          image_model?: string
          image_provider?: string
          image_secondary_key?: string
          instagram_email?: string
          instagram_enabled?: boolean
          instagram_password?: string
          local_agent_url?: string
          research_api_key?: string
          research_depth?: string
          research_provider?: string
          telegram_bot_token?: string
          telegram_chat_id?: string
          telegram_enabled?: boolean
          tiktok_email?: string
          tiktok_enabled?: boolean
          tiktok_password?: string
          updated_at?: string
          upload_mode?: string
          youtube_email?: string
          youtube_enabled?: boolean
          youtube_password?: string
        }
        Relationships: []
      }
      generation_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          error: string | null
          events: Json
          id: string
          include_image: boolean
          platforms: string[]
          prompt: string
          result: Json | null
          saved_post_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          events?: Json
          id?: string
          include_image?: boolean
          platforms?: string[]
          prompt?: string
          result?: Json | null
          saved_post_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          events?: Json
          id?: string
          include_image?: boolean
          platforms?: string[]
          prompt?: string
          result?: Json | null
          saved_post_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      pending_commands: {
        Row: {
          args: Json | null
          command: string
          completed_at: string | null
          created_at: string
          id: string
          result: string | null
          status: string
        }
        Insert: {
          args?: Json | null
          command: string
          completed_at?: string | null
          created_at?: string
          id?: string
          result?: string | null
          status?: string
        }
        Update: {
          args?: Json | null
          command?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          result?: string | null
          status?: string
        }
        Relationships: []
      }
      platform_accounts: {
        Row: {
          created_at: string
          email: string
          enabled: boolean
          id: string
          is_default: boolean
          label: string
          password: string
          platform: string
          recovery_phone: string | null
          target_url: string | null
        }
        Insert: {
          created_at?: string
          email?: string
          enabled?: boolean
          id?: string
          is_default?: boolean
          label?: string
          password?: string
          platform: string
          recovery_phone?: string | null
          target_url?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          enabled?: boolean
          id?: string
          is_default?: boolean
          label?: string
          password?: string
          platform?: string
          recovery_phone?: string | null
          target_url?: string | null
        }
        Relationships: []
      }
      schedule_config: {
        Row: {
          account_selections: Json
          cron_expression: string
          enabled: boolean
          end_at: string | null
          folder_path: string
          id: number
          last_run_at: string | null
          max_runs: number | null
          max_videos: number | null
          name: string
          platforms: string[]
          run_count: number
          updated_at: string
          upload_interval_minutes: number
        }
        Insert: {
          account_selections?: Json
          cron_expression?: string
          enabled?: boolean
          end_at?: string | null
          folder_path?: string
          id?: number
          last_run_at?: string | null
          max_runs?: number | null
          max_videos?: number | null
          name?: string
          platforms?: string[]
          run_count?: number
          updated_at?: string
          upload_interval_minutes?: number
        }
        Update: {
          account_selections?: Json
          cron_expression?: string
          enabled?: boolean
          end_at?: string | null
          folder_path?: string
          id?: number
          last_run_at?: string | null
          max_runs?: number | null
          max_videos?: number | null
          name?: string
          platforms?: string[]
          run_count?: number
          updated_at?: string
          upload_interval_minutes?: number
        }
        Relationships: []
      }
      scheduled_uploads: {
        Row: {
          account_id: string | null
          created_at: string
          description: string
          id: string
          scheduled_at: string
          status: string
          tags: string[]
          target_platforms: string[]
          title: string
          upload_job_id: string | null
          video_file_name: string
          video_storage_path: string | null
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          description?: string
          id?: string
          scheduled_at: string
          status?: string
          tags?: string[]
          target_platforms?: string[]
          title?: string
          upload_job_id?: string | null
          video_file_name: string
          video_storage_path?: string | null
        }
        Update: {
          account_id?: string | null
          created_at?: string
          description?: string
          id?: string
          scheduled_at?: string
          status?: string
          tags?: string[]
          target_platforms?: string[]
          title?: string
          upload_job_id?: string | null
          video_file_name?: string
          video_storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_uploads_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "platform_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_uploads_upload_job_id_fkey"
            columns: ["upload_job_id"]
            isOneToOne: false
            referencedRelation: "upload_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      social_post_accounts: {
        Row: {
          created_at: string
          email: string
          enabled: boolean
          id: string
          is_default: boolean
          label: string
          password: string
          platform: string
          target_url: string | null
        }
        Insert: {
          created_at?: string
          email?: string
          enabled?: boolean
          id?: string
          is_default?: boolean
          label?: string
          password?: string
          platform: string
          target_url?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          enabled?: boolean
          id?: string
          is_default?: boolean
          label?: string
          password?: string
          platform?: string
          target_url?: string | null
        }
        Relationships: []
      }
      social_post_schedules: {
        Row: {
          account_selections: Json
          ai_prompt: string
          auto_publish: boolean
          cron_expression: string
          enabled: boolean
          end_at: string | null
          folder_path: string
          id: number
          imported_files: string[]
          include_image: boolean
          last_run_at: string | null
          name: string
          posts_per_run: number
          run_count: number
          source_type: string
          target_platforms: string[]
          topic_mode: boolean
          updated_at: string
          upload_interval_minutes: number
          variation_hints: string[]
        }
        Insert: {
          account_selections?: Json
          ai_prompt?: string
          auto_publish?: boolean
          cron_expression?: string
          enabled?: boolean
          end_at?: string | null
          folder_path?: string
          id?: number
          imported_files?: string[]
          include_image?: boolean
          last_run_at?: string | null
          name?: string
          posts_per_run?: number
          run_count?: number
          source_type?: string
          target_platforms?: string[]
          topic_mode?: boolean
          updated_at?: string
          upload_interval_minutes?: number
          variation_hints?: string[]
        }
        Update: {
          account_selections?: Json
          ai_prompt?: string
          auto_publish?: boolean
          cron_expression?: string
          enabled?: boolean
          end_at?: string | null
          folder_path?: string
          id?: number
          imported_files?: string[]
          include_image?: boolean
          last_run_at?: string | null
          name?: string
          posts_per_run?: number
          run_count?: number
          source_type?: string
          target_platforms?: string[]
          topic_mode?: boolean
          updated_at?: string
          upload_interval_minutes?: number
          variation_hints?: string[]
        }
        Relationships: []
      }
      social_posts: {
        Row: {
          account_selections: Json
          ai_prompt: string | null
          ai_sources: Json
          completed_at: string | null
          created_at: string
          description: string
          hashtags: string[]
          id: string
          image_path: string | null
          image_paths: string[]
          platform_results: Json
          platform_variants: Json
          scheduled_at: string | null
          status: string
          target_platforms: string[]
        }
        Insert: {
          account_selections?: Json
          ai_prompt?: string | null
          ai_sources?: Json
          completed_at?: string | null
          created_at?: string
          description?: string
          hashtags?: string[]
          id?: string
          image_path?: string | null
          image_paths?: string[]
          platform_results?: Json
          platform_variants?: Json
          scheduled_at?: string | null
          status?: string
          target_platforms?: string[]
        }
        Update: {
          account_selections?: Json
          ai_prompt?: string | null
          ai_sources?: Json
          completed_at?: string | null
          created_at?: string
          description?: string
          hashtags?: string[]
          id?: string
          image_path?: string | null
          image_paths?: string[]
          platform_results?: Json
          platform_variants?: Json
          scheduled_at?: string | null
          status?: string
          target_platforms?: string[]
        }
        Relationships: []
      }
      telegram_bot_state: {
        Row: {
          id: number
          update_offset: number
          updated_at: string
        }
        Insert: {
          id: number
          update_offset?: number
          updated_at?: string
        }
        Update: {
          id?: number
          update_offset?: number
          updated_at?: string
        }
        Relationships: []
      }
      telegram_messages: {
        Row: {
          chat_id: number
          created_at: string
          is_bot: boolean
          raw_update: Json
          text: string | null
          update_id: number
        }
        Insert: {
          chat_id: number
          created_at?: string
          is_bot?: boolean
          raw_update?: Json
          text?: string | null
          update_id: number
        }
        Update: {
          chat_id?: number
          created_at?: string
          is_bot?: boolean
          raw_update?: Json
          text?: string | null
          update_id?: number
        }
        Relationships: []
      }
      upload_jobs: {
        Row: {
          account_id: string | null
          browserbase_session_id: string | null
          completed_at: string | null
          created_at: string
          description: string
          id: string
          platform_results: Json
          status: string
          tags: string[]
          target_platforms: string[]
          title: string
          video_file_name: string
          video_storage_path: string | null
        }
        Insert: {
          account_id?: string | null
          browserbase_session_id?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string
          id?: string
          platform_results?: Json
          status?: string
          tags?: string[]
          target_platforms?: string[]
          title?: string
          video_file_name: string
          video_storage_path?: string | null
        }
        Update: {
          account_id?: string | null
          browserbase_session_id?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string
          id?: string
          platform_results?: Json
          status?: string
          tags?: string[]
          target_platforms?: string[]
          title?: string
          video_file_name?: string
          video_storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "upload_jobs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "platform_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cancel_stale_generation_jobs: { Args: never; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
