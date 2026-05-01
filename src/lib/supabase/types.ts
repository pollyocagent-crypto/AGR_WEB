// Auto-generate after project is linked: npx supabase gen types typescript --local
// Manually maintained until then.

export type CommandStatus = "pending" | "sent" | "acked" | "failed";
export type DeviceRole = "owner" | "member";

export interface Database {
  public: {
    Tables: {
      devices: {
        Row: {
          id: string;
          device_uid: string;
          firmware_version: string | null;
          last_seen_at: string | null;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["devices"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["devices"]["Insert"]>;
      };
      device_owners: {
        Row: {
          device_id: string;
          user_id: string;
          role: DeviceRole;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["device_owners"]["Row"], "created_at">;
        Update: Partial<Pick<Database["public"]["Tables"]["device_owners"]["Row"], "role">>;
      };
      device_state: {
        Row: {
          device_id: string;
          state: Record<string, unknown>;
          updated_at: string;
        };
        Insert: Database["public"]["Tables"]["device_state"]["Row"];
        Update: Partial<Database["public"]["Tables"]["device_state"]["Insert"]>;
      };
      device_commands: {
        Row: {
          id: string;
          device_id: string;
          payload: Record<string, unknown>;
          requested_by: string;
          status: CommandStatus;
          created_at: string;
          acked_at: string | null;
        };
        Insert: Omit<Database["public"]["Tables"]["device_commands"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["device_commands"]["Insert"]>;
      };
      pairing_codes: {
        Row: {
          code: string;
          device_id: string;
          expires_at: string;
        };
        Insert: Database["public"]["Tables"]["pairing_codes"]["Row"];
        Update: never;
      };
      firmware_releases: {
        Row: {
          version: string;
          r2_object_key: string;
          sha256: string;
          notes: string | null;
          published_at: string;
        };
        Insert: Database["public"]["Tables"]["firmware_releases"]["Row"];
        Update: Partial<Database["public"]["Tables"]["firmware_releases"]["Insert"]>;
      };
    };
    Views: Record<string, never>;
    Functions: {
      user_owns_device: {
        Args: { p_device_id: string };
        Returns: boolean;
      };
      pair_device: {
        Args: { p_code: string };
        Returns: string;
      };
      request_command: {
        Args: { p_device_id: string; p_payload: Record<string, unknown> };
        Returns: string;
      };
    };
    Enums: {
      command_status: CommandStatus;
      device_role: DeviceRole;
    };
  };
}

export type Device = Database["public"]["Tables"]["devices"]["Row"];
export type DeviceOwner = Database["public"]["Tables"]["device_owners"]["Row"];
export type DeviceState = Database["public"]["Tables"]["device_state"]["Row"];
export type DeviceCommand = Database["public"]["Tables"]["device_commands"]["Row"];
export type PairingCode = Database["public"]["Tables"]["pairing_codes"]["Row"];
export type FirmwareRelease = Database["public"]["Tables"]["firmware_releases"]["Row"];
