import { MemoryStick } from 'lucide-react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const ramOptions = ['1G', '2G', '3G', '4G', '6G', '8G', '10G', '12G', '16G']

interface RamSettingsProps {
  minRam: string
  maxRam: string
  onMinChange: (value: string) => void
  onMaxChange: (value: string) => void
}

export function RamSettings({ minRam, maxRam, onMinChange, onMaxChange }: RamSettingsProps) {
  return (
    <div className="flex items-center gap-4">
      <MemoryStick className="h-4 w-4 text-zinc-500 shrink-0" />

      <div className="flex items-center gap-2">
        <Label className="text-xs text-zinc-400 whitespace-nowrap">RAM min</Label>
        <Select value={minRam} onValueChange={onMinChange}>
          <SelectTrigger className="w-[80px] h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ramOptions.map(v => (
              <SelectItem key={v} value={v}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Label className="text-xs text-zinc-400 whitespace-nowrap">RAM max</Label>
        <Select value={maxRam} onValueChange={onMaxChange}>
          <SelectTrigger className="w-[80px] h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ramOptions.map(v => (
              <SelectItem key={v} value={v}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
