#!/data/data/com.termux/files/usr/bin/perl
# wisp TUI — touch control for the RTL8761 BLE adapter. Modelled on the ax56 sensor.pl:
# muted semantic palette, box-drawing glyphs, two-column layout (lists left / big thumb
# buttons right), atomic synchronized frames (no flicker), a loading state on every action.
# NO shell-out: actions stream the driver's output live into an in-screen LOG. Own-device use.
use strict; use warnings;
use IO::Select;
use Fcntl qw(F_GETFL F_SETFL O_NONBLOCK);
binmode(STDOUT, ":encoding(UTF-8)");
my $T    = "/root/rtl8761-bt";
my $WISP = "$T/wisp";

# ---- palette (muted, semantic) + glyphs ----
my %C = (
  acc=>"38;5;44", accb=>"38;5;44;1", hdr=>"48;5;23;38;5;231;1",
  tabon=>"48;5;44;38;5;16;1", taboff=>"38;5;66", dim=>"38;5;244",
  warn=>"38;5;214", ok=>"38;5;42", name=>"38;5;180", rnd=>"38;5;140",
  hot=>"48;5;236;38;5;44;1", busy=>"48;5;236;38;5;227;1",
  scan=>"48;5;24;38;5;231;1",  scanon=>"48;5;28;38;5;231;1",
  adv=>"48;5;94;38;5;231;1",   advon=>"48;5;208;38;5;16;1",
  pair=>"48;5;54;38;5;231;1",  pairon=>"48;5;141;38;5;16;1",
  quit=>"38;5;231;48;5;238",
);
sub col { my ($s,$k)=@_; return $s unless $C{$k}; "\e[$C{$k}m$s\e[0m" }
my %BX = (h=>"\x{2500}",v=>"\x{2502}",vr=>"\x{251c}",lr=>"\x{2570}",dot=>"\x{00b7}",
          bul=>"\x{25cf}",arr=>"\x{2192}",blk=>"\x{2588}",lo=>"\x{2591}");
my @SPIN = map { chr } (0x280b,0x2819,0x2839,0x2838,0x283c,0x2834,0x2826,0x2827,0x2807,0x280f);
sub at   { "\e[$_[0];$_[1]H" }
sub pad  { my ($s,$w)=@_; $w=0 if $w<0; $s=substr($s,0,$w); my $n=$w-length($s); $n>0 ? $s.(" "x$n) : $s }
sub cen  { my ($s,$w)=@_; $w=0 if $w<0; $s=substr($s,0,$w); my $l=int(($w-length $s)/2); $l=0 if $l<0; (" "x$l).$s.(" "x($w-length($s)-$l)) }

# ---- state ----
my $tab = "devices";                       # devices (NOW) | all | info | adv | log
my $target = ""; my $tname = ""; my $tid = "";
my @dev;                                   # [mac, signal%, name, type, ident, last-seen epoch, appearance, public|random] — one row per MAC, kept all session
my %probe;                                 # mac -> {status, svcs=>[{uuid,label,chars=>[{uuid,flags,name,val,label}]}], nuuid, nlines=>[]}
sub tdev { my ($d)=grep{$_->[0] eq $target} @dev; $d }
my $run_tgt = "";                          # MAC the running probe/notify belongs to (target may change meanwhile)
my $NOW_SECS = 10;                         # NOW = heard within the last 10 s
sub live { my $t=time; grep { $t-$_->[5] <= $NOW_SECS } @dev }
sub apple_devs { grep { ($_->[4]//"") =~ /Apple|Find My|AirPods|Handoff|AirDrop|Nearby|AirPlay|Hey Siri|Watch|Tethering|TRACKER|Tile|SmartTag/ } @dev }
my %sel = (brand=>0, power=>2, time=>1);
my $advname = "";                          # custom Swift Pair name typed for the Windows brand ("" = rotating)
my $editing = 0;                           # typing into the NAME field
my @BRANDS = (["apple","Apple"],["samsung","Samsung"],["google","Google"],["windows","Windows"],["all","All"]);
my @POWER  = (["","default",0],["4","+4 dBm",4],["9","+9 dBm",9],["12","+MAX",12]);
my @TIMES  = (15,30,60,0);                 # 0 = manual: runs until ADVERTISE is tapped again
sub tlabel { $_[0] ? $_[0]."s" : "manual" }
my $status = "ready";
my @btn;                                   # [x1,y1,x2,y2,id]
my ($run_fh,$run_pid,$run_mode,$run_lbl);  # live child (no shell-out)
my $scan_on = 0;                           # SCAN toggled on: keep scanning until tapped off
my @log; my $rbuf=""; my $spin=0;
sub range_m { my $d=shift; int(10*(2**($d/6))+0.5) }
my $FAKEBUSY; sub busy { defined($run_fh) || $FAKEBUSY }
sub sp { $SPIN[$spin % @SPIN] }

# ---- size (stty; overridable for --shot) ----
our ($OVR_C,$OVR_R);
sub size { return ($OVR_C,$OVR_R) if $OVR_C; my $s=`stty size 2>/dev/null`; my ($r,$c)=split /\s+/,($s||"");
  ($c&&$c>24?$c:48, $r&&$r>16?$r:30) }

# ================= draw (build one coloured string, paint every cell, flush atomically) =================
sub draw {
  @btn=();
  my ($W,$H)=size();
  my $RW=int($W*0.40); $RW=22 if $RW>22; $RW=16 if $RW<16;
  my $rx=$W-$RW+1; my $LW=$rx-2; $LW=1 if $LW<1;
  my $o="\e[H";

  # ---------- LEFT: tab bar ----------
  my @tabs=(["devices","NOW ".scalar(live())],["all","ALL ".scalar(@dev)],["apple","APPLE ".scalar(apple_devs())],["info","INFO"],["adv","ADV"],["log","LOG"]);
  { my $cx=1; for my $t (@tabs){ my $l=" ".$t->[1]." "; $o.=at(1,$cx).col($l,$t->[0]eq$tab?"tabon":"taboff"); push @btn,[$cx,1,$cx+length($l)-1,1,"tab:$t->[0]"]; $cx+=length($l); }
    $o.=at(1,$cx).col(pad("",$LW-$cx+1),"taboff") if $cx<=$LW; }

  # ---------- LEFT: active view rows ----------
  my @rows;
  if ($tab eq "devices" || $tab eq "all") {
    my @list = $tab eq "all" ? @dev : live();
    push @rows,{t=>" ".(busy()&&($run_mode//"")eq"scan"?sp()." scanning…":"tap SCAN to listen"),key=>"dim"} unless @list;
    for my $d (@list){ my ($m,$r,$n,undef,$id,undef,$ap)=@$d; $id//=""; $ap//="";
      my $bars=pad($r>=90?$BX{blk}x3:$r>=64?$BX{blk}x2:$BX{blk},3);
      my $lbl = $n ne"" ? $n : $id;                                         # name, else what ident says it is
      $lbl = $lbl ne"" ? "$ap $BX{dot} $lbl" : $ap if $ap ne"";             # device type (SIG Appearance) first
      my $line = $lbl ne"" ? sprintf(" %s %s %s%5s",$BX{bul},pad($lbl,$LW-17),$bars,"$r%")
                           : sprintf(" %s %s %s%5s",$BX{bul},$m,$bars,"$r%");  # full MAC, never cut
      push @rows,{t=>$line,key=>(lc$m eq lc$target?"hot":($n?"name":($id?"rnd":"acc"))),id=>"dev:$m"};
    }
  } elsif ($tab eq "apple") {
    push @rows,{t=>" Apple BLE + trackers (passive)",key=>"dim"};
    my @a = apple_devs();
    push @rows,{t=>" (none yet — tap SCAN)",key=>"dim"} unless @a;
    for my $d (@a){ my ($m,$r,$n,undef,$id)=@$d; $id//="";
      my $msg = $id; $msg=~s/^.*?· //;                                     # drop vendor prefix, keep the Apple/tracker detail
      my $hot = $id=~/TRACKER/;
      push @rows,{t=>sprintf(" %s %s %3s%%",$hot?$BX{bul}:$BX{dot},pad(($n ne""?$n:$msg),$LW-8),$r),key=>($hot?"warn":"name"),id=>"dev:$m"};
      push @rows,{t=>"   ".$m,key=>"dim"};
    }
  } elsif ($tab eq "info") {
    push @rows, info_rows();
  } elsif ($tab eq "adv") {
    push @rows,{t=>" BRAND",key=>"dim"};
    push @rows,{t=>" ".($sel{brand}==$_?$BX{bul}:$BX{dot})." ".$BRANDS[$_][1],key=>($sel{brand}==$_?"accb":"name"),id=>"brand:$_"} for 0..$#BRANDS;
    if($BRANDS[$sel{brand}][0] eq "windows"){                 # Windows Swift Pair shows a name in its toast
      push @rows,{t=>" NAME ".$BX{dot}." Windows toast",key=>"dim"};
      my $shown = $editing ? $advname."_" : ($advname ne"" ? $advname : "tap to type (random)");
      push @rows,{t=>"  ".$shown,key=>($editing?"accb":"acc"),id=>"nameedit"};
    }
    push @rows,{t=>" POWER ".$BX{dot}." range",key=>"dim"};
    push @rows,{t=>" ".($sel{power}==$_?$BX{bul}:$BX{dot})." ".pad($POWER[$_][1],8)."~".range_m($POWER[$_][2])."m",key=>($sel{power}==$_?"accb":"acc"),id=>"pow:$_"} for 0..$#POWER;
    push @rows,{t=>" TIME",key=>"dim"};
    { my $l=" "; $l.=($sel{time}==$_?"[".tlabel($TIMES[$_])."]":" ".tlabel($TIMES[$_])." ")." " for 0..$#TIMES; push @rows,{t=>$l,key=>"acc",id=>"timerow"} }
  } else {
    my $n=$H-2; my @tail=@log>$n?@log[-$n..-1]:@log;
    push @rows,{t=>" ".$_,key=>($_=~/ENCRYPTED|verified|CONNECTED|MATCH|ok/?"ok":($_=~/FAIL|denied|error|timeout/i?"warn":"dim"))} for @tail;
    push @rows,{t=>" (no output yet)",key=>"dim"} unless @log;
  }
  my $ry=2;
  for my $rr (@rows){ last if $ry>$H; $o.=at($ry,1).col(pad($rr->{t},$LW),$rr->{key}); push @btn,[1,$ry,$LW,$ry,$rr->{id}] if $rr->{id}; $ry++; }
  $o.=at($_,1).(" "x$LW) for ($ry..$H);                # clear the rest of the left column
  $o.=at($_,$rx-1).col($BX{v},"dim") for (1..$H);      # divider

  # ---------- RIGHT: target + selection + progress ----------
  my $b=$BRANDS[$sel{brand}][1]; my $pw=$POWER[$sel{power}][1]; my $rm=range_m($POWER[$sel{power}][2]);
  $o.=at(1,$rx).col(pad(" TARGET",$RW),"hdr");
  $o.=at(2,$rx).col(pad(" ".($target ne""?($tname ne""?$tname:$target):"tap a device "),$RW),"accb");
  $o.=at(3,$rx).col(pad(" ".$target,$RW),"dim");
  push @btn,[$rx,1,$W,3,"cleartgt"];
  $o.=at(4,$rx).col(pad(" ".$tid,$RW),"rnd");
  $o.=at(5,$rx).col(pad(" ADV  ".$b,$RW),"hdr");
  $o.=at(6,$rx).col(pad("  ".$pw."  ~${rm}m  ".tlabel($TIMES[$sel{time}]),$RW),"dim");
  my $prog = busy() ? sp()." ".($run_lbl//"working") : (@log?$log[-1]:"idle");
  $o.=at(7,$rx).col(pad(" ".$prog,$RW), busy()?"busy":"dim");
  $o.=at(8,$rx).(" "x$RW);

  # ---------- RIGHT: big buttons (rows 9..): SCAN / ADVERTISE / PAIR / PROBE / QUIT ----------
  my $top=9; my $ah=int(($H-$top-1)/4); $ah=4 if $ah>4; $ah=2 if $ah<2;
  my $srun=busy()&&($run_mode//"")eq"scan"; my $arun=busy()&&($run_mode//"")eq"adv"; my $prun=busy()&&($run_mode//"")eq"pair";
  my $orun=busy()&&($run_mode//"")=~/^(probe|notify)$/;
  my @blk=(
    [($srun?"scanon":"scan"), $srun?sp()." SCANNING":"SCAN", $srun?"tap to stop":"listen", "scan"],
    [($arun?"advon":"adv"),   $arun?sp()." ADVERTISING":"ADVERTISE", $arun?"tap to stop":"$b $pw", "adv"],
    [($prun?"pairon":"pair"), $prun?sp()." PAIRING":"PAIR", $prun?"bonding…":($target ne""?"connect+bond":"pick target"), "pair"],
    [($orun?"pairon":"pair"), $orun?sp()." ".uc($run_mode):"PROBE", $orun?"tap to stop":($target ne""?"read GATT":"pick target"), "probe"],
  );
  my $y=$top;
  for my $bl (@blk){ my ($key,$l1,$l2,$id)=@$bl; my $y2=$y+$ah-1; my $mid=int(($y+$y2)/2);
    for my $r ($y..$y2){ my $line=$r==$mid?cen($l1,$RW):($r==$mid+1&&$l2 ne""?cen($l2,$RW):(" "x$RW)); $o.=at($r,$rx).col($line,$key); }
    push @btn,[$rx,$y,$W,$y2,$id]; $y=$y2+1;
  }
  { my $qy=$y; my $qy2=$y+1<$H?$y+1:$H;
    for my $r ($qy..$qy2){ $o.=at($r,$rx).col($r==$qy?cen("QUIT",$RW):(" "x$RW),"quit"); }
    push @btn,[$rx,$qy,$W,$qy2,"quit"];
    $o.=at($_,$rx).(" "x$RW) for ($qy2+1..$H);         # paint remaining right rows (no residue)
  }
  print "\e[?2026h".$o."\e[?2026l";                    # atomic frame — no flicker
}

# ---- runner: live, no shell-out; child stdout piped in and streamed to @log ----
sub start_run {
  my ($mode,$lbl,@cmd)=@_;
  stop_run();
  $scan_on=0 if $mode ne "scan";                 # one radio: any other action ends continuous SCAN
  @log=(); $rbuf=""; $run_mode=$mode; $run_lbl=$lbl;
  pipe(my $rd,my $wr) or do { $status="pipe fail"; return };
  my $pid=fork();
  if(!defined $pid){ $status="fork fail"; close $rd; close $wr; return }
  if($pid==0){                                   # child: own process group so we can signal the whole tree
    setpgrp(0,0);
    open(STDOUT,">&",$wr); open(STDERR,">&",$wr); close $rd; close $wr;
    exec(@cmd); exit 127;
  }
  close $wr; $run_fh=$rd; $run_pid=$pid;
  my $fl=fcntl($run_fh,F_GETFL,0); fcntl($run_fh,F_SETFL,$fl|O_NONBLOCK);
  $status="$lbl…";
}
# signal the advertiser / live scanner DIRECTLY by the pid it wrote, so it turns the radio off before
# dying (group-kill alone is unreliable through timeout/termux-usb). Waits until it is confirmed off.
sub advpid_term {
  my $f="$T/".(shift//".advpid"); return unless -e $f;
  open(my $fh,"<",$f) or return; my $pid=<$fh>//""; close $fh; $pid=~s/\D//g; return unless $pid;
  my $cmd=""; if(open(my $c,"<","/proc/$pid/cmdline")){ local $/; $cmd=<$c>//""; close $c; }
  return unless $cmd=~/bt\.ts|deno/;                 # safety: only signal our actual driver, not a reused pid
  kill('TERM',$pid);
  for (1..30){ last unless (-e $f) && kill(0,$pid); select(undef,undef,undef,0.05); }  # up to ~1.5s
}
# stop AND resolve advertising: direct-signal the driver, then tear the process group down
sub stop_run {
  return unless $run_fh;
  advpid_term(); advpid_term(".scanpid");
  if($run_pid){ kill('TERM',-$run_pid); select(undef,undef,undef,0.20); kill('KILL',-$run_pid) if kill(0,-$run_pid); }
  close($run_fh); waitpid($run_pid,0) if $run_pid; $run_fh=undef; $run_mode=undef; $status="stopped";
}
sub pump_run {
  return 0 unless $run_fh;
  my $data; my $n=sysread($run_fh,$data,8192);
  if(!defined $n){ return 1 }
  if($n==0){ close($run_fh); waitpid($run_pid,0) if $run_pid; $run_fh=undef;
    if($scan_on && ($run_mode//"")eq"scan"){ $run_mode=undef; scan_start(); return 1 }  # continuous: relaunch while SCAN is on
    if(($run_mode//"") eq "probe" && (my $p=$probe{$run_tgt})){   # final PROBE verdict
      my $n=@{$p->{svcs}}; $p->{status} = $n ? "$n service(s)" : (($p->{status}//"")=~/FAIL|no /?$p->{status}:"failed, see LOG") }
    if(($run_mode//"") eq "notify" && (my $p=$probe{$run_tgt})){ $p->{nstatus}="failed, see LOG" if ($p->{nstatus}//"")=~/^listening/ }
    $status=($run_mode//"")." done"; $run_mode=undef; return 0 }
  $rbuf.=$data;
  while($rbuf=~s/^(.*?)\n//){ my $ln=$1; $ln=~s/\e\[[0-9;]*[A-Za-z]//g; push @log,$ln; shift @log while @log>200;
    if(($run_mode//"") eq "scan" && $ln=~/^\s*([0-9a-f:]{17})\s+(\d+)%\s+(public|random)\s*(.*)$/){
      my ($mac,$rs,$kd,$nm)=($1,$2,$3,$4//""); my $f; my $id=""; my $ap="";  # update by MAC so the list persists across relaunches
      ($nm,$id)=($1,$2) if $nm=~/^(.*?)\s*~ (.*)$/;            # "<name>  [<appearance>]  ~ <ident>" from bt.ts
      ($nm,$ap)=($1,$2) if $nm=~/^(.*?)\s*\[([^\]]*)\]$/;
      for my $d (@dev){ if($d->[0] eq $mac){ $d->[1]=$rs; $d->[2]=$nm if $nm ne ""; $d->[4]=$id if $id ne ""; $d->[6]=$ap if $ap ne ""; $d->[5]=time; $d->[7]=$kd; $f=1; last } }
      push @dev,[$mac,$rs,$nm,0,$id,time,$ap,$kd] unless $f; }
    elsif(($run_mode//"") =~ /^(probe|notify)$/){ probe_line($ln) } }
  return 1;
}
# ---- PROBE (wisp read) / NOTIFY (wisp notify) output -> %probe{$target} ----
# "gb:gree UUID_CHARACTERISTIC_PACK_TX" -> "PACK_TX"; SIG member owners say who registered the number,
# not what the characteristic is, so those fall back to the raw UUID
sub short_lbl { my $s=shift//""; return "" if $s=~/^member: /; $s=~s/^gb:\S+ //; $s=~s/^UUID_(?:CHARACTERISTIC|SERVICE)_//; $s }
sub show_val {                                                    # printable text as "..", else hex
  my ($hx,$asc)=@_; my @b=map{hex} split / /,$hx; pop @b while @b && !$b[-1];
  return "\"".join("",map{chr}@b)."\"" if @b && !grep{$_<0x20||$_>0x7e}@b;
  $hx }
sub probe_line {
  my $ln=shift; my $p=$probe{$run_tgt}//={svcs=>[],nlines=>[]};
  if($ln=~/^  service (\S+) \[0x[0-9a-f]+-0x[0-9a-f]+\]\s*(.*)$/){ push @{$p->{svcs}},{uuid=>$1,label=>short_lbl($2),chars=>[]} }
  elsif($ln=~/^ {4}(\S+) h=0x[0-9a-f]+ \[([RWNI-]{4})\] (.{16}) ?(.*)$/ && @{$p->{svcs}}){
    my ($u,$fl,$nm,$rest)=($1,$2,$3,$4); $nm=~s/\s+$//; my $lb="";
    $lb=short_lbl($1) if $rest=~s/\s*~ (.*)$//;
    my $ap=$rest=~s/\s*\[([^\]]*)\]$// ? $1 : "";
    my $v = $rest=~/^= <read denied>/ ? "denied" : $rest=~/^= ((?:[0-9a-f]{2} ?)+)/ ? show_val($1=~s/ $//r) : "";
    $v.=" ($ap)" if $ap ne"";
    push @{$p->{svcs}[-1]{chars}},{uuid=>$u,flags=>$fl,name=>($nm ne""?$nm:$lb),val=>$v} }
  elsif($ln=~/^\s*\[\s*([\d.]+s)\] h=0x[0-9a-f]+ ((?:[0-9a-f]{2} ?)+)/){ push @{$p->{nlines}},"$1  ".show_val($2=~s/ $//r) }
  elsif($ln=~/^notify: (\d+ notification\(s\)|no notify.*|no CCCD.*|connection FAILED.*|no connectable target.*)/){ $p->{nstatus}=$1 }
  elsif($ln=~/^read: (CONNECTED.*|connection FAILED.*|no connectable target.*)$/){ $p->{status}=$1 }
}
sub info_rows {
  my @r;
  return ({t=>" tap a device in NOW / ALL",key=>"dim"}) unless $target ne"";
  my $d=tdev(); my ($rs,$nm,$id,$seen,$ap,$kd)=$d?@$d[1,2,4,5,6,7]:("","","","","","");
  push @r,{t=>" ".($nm ne""?$nm:"(no name)"),key=>"accb"};
  push @r,{t=>" $target".($kd?" $BX{dot} $kd":""),key=>"acc"};
  push @r,{t=>" signal ".($rs ne""?"$rs%":"?").($seen?" $BX{dot} heard ".(time-$seen)."s ago":""),key=>"dim"};
  push @r,{t=>" type ".($ap ne""?$ap:"(not advertised)"),key=>"name"};
  push @r,{t=>" $id",key=>"rnd"} if ($id//"") ne"";
  my $p=$probe{$target};
  push @r,{t=>" $BX{h}$BX{h} GATT ".($p&&$p->{status}?$p->{status}:"(tap PROBE)"),key=>"dim"};
  for my $s ($p?@{$p->{svcs}}:()){
    push @r,{t=>" $BX{vr} ".($s->{label} ne""?$s->{label}:$s->{uuid}),key=>"accb"};
    for my $c (@{$s->{chars}}){
      my $listen=$c->{flags}=~/[NI]/;
      push @r,{t=>"   $c->{flags} ".($c->{name} ne""?$c->{name}:$c->{uuid}).($c->{val} ne""?" $c->{val}":"").($listen?" $BX{arr} listen":""),
               key=>($listen?"ok":"acc"),($listen?(id=>"chr:$c->{uuid}"):())};
    }
  }
  if($p && $p->{nuuid}){
    push @r,{t=>" $BX{h}$BX{h} NOTIFY $p->{nuuid} ".($p->{nstatus}//""),key=>"dim"};
    push @r,{t=>"   $_",key=>"ok"} for @{$p->{nlines}};
    push @r,{t=>"   (nothing yet)",key=>"dim"} unless @{$p->{nlines}};
  }
  @r }
sub scan_start { start_run("scan","scanning","bash",$WISP,"live"); }   # one long-lived scan, lines streamed as heard
sub act_scan { if($scan_on){ $scan_on=0; stop_run(); return } $scan_on=1; $tab="devices"; scan_start(); }  # toggle: on = listen continuously
sub act_adv  {
  if(busy()&&($run_mode//"")eq"adv"){stop_run();return}
  my $k=$POWER[$sel{power}][0]; my @a=("bash",$WISP,"adv",$BRANDS[$sel{brand}][0],$TIMES[$sel{time}]); push @a,$k if $k ne"";
  if($BRANDS[$sel{brand}][0] eq "windows" && $advname ne""){ local $ENV{BT_ADV_NAME}=$advname; start_run("adv","advertising",@a) }
  else { start_run("adv","advertising",@a) }
}
sub act_pair { if(!$target){$status="pick a target first";$tab="devices";return} if(busy()&&($run_mode//"")eq"pair"){stop_run();return} local $ENV{BT_TARGET}=$target; $tab="log"; start_run("pair","pairing","bash",$WISP,"pair"); }
# PROBE: connect + read every service/characteristic (wisp read); results land in the INFO tab
sub act_probe {
  if(!$target){$status="pick a target first";$tab="devices";return}
  if(busy()&&($run_mode//"")=~/^(probe|notify)$/){stop_run();return}
  $run_tgt=$target; $probe{$target}={svcs=>[],nlines=>[],status=>"connecting…"}; $tab="info";
  local $ENV{BT_TARGET}=$target; local $ENV{BT_SCAN_SECS}=3; start_run("probe","probing","bash",$WISP,"read");
}
# tap a notify/indicate characteristic: subscribe 15 s (wisp notify); values arrive when it ends
sub act_notify {
  my $u=shift; return unless $target;
  my $p=$probe{$target}//={svcs=>[],nlines=>[]}; $p->{nuuid}=$u; $p->{nlines}=[]; $p->{nstatus}="listening 15s…";
  $run_tgt=$target; $tab="info";
  local $ENV{BT_TARGET}=$target; local $ENV{BT_SCAN_SECS}=3; local $ENV{BT_NOTIFY_UUID}=$u; local $ENV{BT_NOTIFY_SECS}=15;
  start_run("notify","listening","bash",$WISP,"notify");
}

# ---- hit-test ----
sub tap {
  my ($x,$y)=@_;
  for my $b (@btn){ next unless $y>=$b->[1] && $y<=$b->[3] && $x>=$b->[0] && $x<=$b->[2]; my $id=$b->[4];
    $editing=0 unless $id eq "nameedit";                 # any other tap leaves the name field
    if($id eq "nameedit"){ $editing=!$editing }
    elsif($id=~/^tab:(\w+)/){ $tab=$1 }
    elsif($id=~/^dev:(.+)/){ $target=$1; my $d=tdev(); $tname=$d?($d->[2]//""):""; $tid=$d?join(" $BX{dot} ",grep{$_ ne""}($d->[6]//"",$d->[4]//"")):""; $status="target $1"; $tab="info" }
    elsif($id=~/^chr:(.+)/){ act_notify($1) }
    elsif($id=~/^brand:(\d+)/){ $sel{brand}=$1 }
    elsif($id=~/^pow:(\d+)/){ $sel{power}=$1 }
    elsif($id eq "timerow"){ $sel{time}=($sel{time}+1)%@TIMES }
    elsif($id eq "cleartgt"){ $target="";$tname="";$tid="" }
    elsif($id eq "scan"){ act_scan() }
    elsif($id eq "adv"){ act_adv() }
    elsif($id eq "pair"){ act_pair() }
    elsif($id eq "probe"){ act_probe() }
    elsif($id eq "quit"){ stop_run(); tui_off(); exit 0 }
    return 1;
  }
  0;
}

# ---- headless flatten + --shot (for design review) ----
sub flatten { my ($s,$C2,$R2)=@_; utf8::decode($s); my @g=map{[(' ')x$C2]}1..$R2; my ($x,$y)=(1,1);
  while(length $s){ if($s=~s/^\e\[(\d+);(\d+)H//){$y=$1;$x=$2}
    elsif($s=~s/^\e\[\?\d+[hl]//){} elsif($s=~s/^\e\[[0-9;]*[A-Za-z]//){}
    elsif($s=~s/^(.)//s){ my $ch=$1; $g[$y-1][$x-1]=$ch if $ch!~/[\n\r]/&&$y>=1&&$y<=$R2&&$x>=1&&$x<=$C2; $x++ if $ch!~/[\n\r]/ } }
  join("\n",map{join('',@$_)}@g); }
if (@ARGV && $ARGV[0] eq "--shot"){ $tab=$ARGV[1]//"devices"; ($OVR_C,$OVR_R)=($ARGV[2]||48,$ARGV[3]||30);
  $sel{brand}=$ENV{SHOT_BRAND} if defined $ENV{SHOT_BRAND}; $advname=$ENV{SHOT_NAME}//""; $editing=1 if $ENV{SHOT_EDIT};
  if($ARGV[4]){ $FAKEBUSY=1; $run_mode=$ARGV[4]; $run_lbl={scan=>"scanning",adv=>"advertising",pair=>"pairing"}->{$ARGV[4]}//"working"; }
  my $t=time;
  @dev=(["68:85:d3:1c:ca:18",100,"Buds4 Pro",1,"Samsung Electronics Co. Ltd.",$t,"Earbud","random"],["c0:39:37:a9:ff:92",84,"GR-AC",0,"Gree Air Conditioner",$t-2,"","public"],
        ["77:e3:17:4e:34:2c",32,"",1,"Apple, Inc.",$t-5,"Phone","random"],["55:05:72:e2:c1:45",60,"",1,"",$t-60,"","random"]);
  $target="c0:39:37:a9:ff:92"; $tname="GR-AC"; $tid="Gree Air Conditioner";
  if($ENV{SHOT_PROBE} && open(my $pf,"<",$ENV{SHOT_PROBE})){ $run_tgt=$target; $probe{$target}={svcs=>[],nlines=>[],nuuid=>$ENV{SHOT_NUUID}}; while(my $l=<$pf>){ chomp $l; probe_line($l) } close $pf; }  # replay real wisp read/notify output
  @log=("pair: CONNECTED handle=0x10","pair: Sconfirm verified","pair: LINK ENCRYPTED","pair: read 7772e5db = 00");
  my $cap=""; { local *STDOUT; open(STDOUT,">",\$cap); draw(); } binmode(STDOUT,":utf8");
  my ($w,$h)=($OVR_C,$OVR_R); print "+",("-"x$w),"+\n"; print "|$_|\n" for split/\n/,flatten($cap,$w,$h); print "+",("-"x$w),"+\n"; exit 0; }

# ---- terminal ----
sub tui_on  { system("stty raw -echo 2>/dev/null"); print "\e[?1049h\e[?25l\e[?1000h\e[?1006h"; }
sub tui_off { print "\e[?1000l\e[?1006l\e[?25h\e[?1049l"; system("stty sane 2>/dev/null"); }
$SIG{INT}=$SIG{TERM}=sub{ stop_run(); tui_off(); exit 0 }; $|=1;

# ---- main select loop (STDIN + live child; atomic redraw only when dirty) ----
tui_on(); draw();
my $ibuf="";
while(1){
  my $s=IO::Select->new(\*STDIN); $s->add($run_fh) if $run_fh;
  my @r=$s->can_read(busy()?0.12:undef);
  my $dirty=0;
  if(busy() && !@r){ $spin++; pump_run(); $dirty=1 }
  for my $fh (@r){
    next unless defined fileno($fh);                     # run handle closed earlier this round (e.g. a tap restarted the run)
    if(fileno($fh)==fileno(\*STDIN)){
      my $c; my $n=sysread(STDIN,$c,256); if(!defined $n||$n==0){ stop_run(); tui_off(); exit 0 } $ibuf.=$c;
      while(1){
        if($ibuf=~s/^\e\[<(\d+);(\d+);(\d+)([Mm])//){ my ($bc,$mx,$my,$pr)=($1,$2,$3,$4);
          next unless $pr eq "M" && ($bc&0x43)==0; $dirty=1 if tap($mx,$my); }
        elsif($editing){                                   # typing into the NAME field
          if($ibuf=~s/^[\r\n]//){ $editing=0; $dirty=1 }                      # Enter confirms
          elsif($ibuf=~s/^(?:\x7f|\x08)//){ chop $advname; $dirty=1 }         # Backspace
          elsif($ibuf=~s/^\e\[[0-9;<]*[A-Za-z]//){ }                          # ignore arrows / stray CSI
          elsif($ibuf=~/^\e/){ last }                                          # incomplete escape: wait
          elsif($ibuf=~s/^([\x20-\x7e])//){ $advname.=$1 if length($advname)<24; $dirty=1 }
          else { last } }
        elsif($ibuf=~s/^q//){ stop_run(); tui_off(); exit 0 }
        elsif($ibuf=~/^\e/){ last } elsif($ibuf=~s/^.//s){} else { last }
      }
    } else { pump_run(); $dirty=1 }
  }
  draw() if $dirty;
}
